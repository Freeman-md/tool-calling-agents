import readline from "node:readline/promises";
import {
  stdin as inputStream,
  stdout as outputStream,
} from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { OpenAI } from "openai/client.js";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems.js";
import { z } from "zod";

const openai = new OpenAI()

const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

/* -------------------------------------------------------------------------- */
/*                                   Schemas                                  */
/* -------------------------------------------------------------------------- */

const DurationSchema = z.union([
    z.literal(30),
    z.literal(45),
    z.literal(60),
    z.literal(90),
])

const FindSlotsArguments = z.object({
    timezone: z.string().trim().min(1),
    duration_minutes: DurationSchema
})

const PrepareBookingArguments = z.object({
    slot_id: z.string().trim().min(1),
    name: z.string().trim().min(2),
    email: z.string().trim().email(),
})

const BookConsultationArguments = z.object({
    pending_booking_id: z.string().uuid(),
})

type SupportedDuration = z.infer<typeof DurationSchema>;

type ConsultationSlot = {
    id: string;
    starts_at: string;
    timezone: string;
    duration_minutes: SupportedDuration;
};

type AvailabilityState = {
    checked_at: string;
    timezone: string;
    duration_minutes: SupportedDuration;
    slots: ConsultationSlot[];
};

type PendingBooking = {
    id: string;
    slot_id: string;
    starts_at: string;
    timezone: string;
    duration_minutes: SupportedDuration;
    name: string;
    email: string;
    idempotency_key: string;
    status:
    | "awaiting_confirmation"
    | "confirmed"
    | "booked"
    | "invalid";
};

type ConfirmedBooking = {
    booking_id: string;
    pending_booking_id: string;
    slot_id: string;
    starts_at: string;
    timezone: string;
    duration_minutes: SupportedDuration;
    name: string;
    email: string;
    status: "confirmed";
    created_at: string;
};

type WorkflowState = {
    availability: AvailabilityState | null;
    pending_booking: PendingBooking | null;
    last_booking: ConfirmedBooking | null;
};

type ToolResult =
    | {
        ok: true;
        [key: string]: unknown;
    }
    | {
        ok: false;
        code: string;
        message: string;
        retryable?: boolean;
    };

/* -------------------------------------------------------------------------- */
/*                              Application state                             */
/* -------------------------------------------------------------------------- */

const workflow: WorkflowState = {
    availability: null,
    pending_booking: null,
    last_booking: null,
};

/**
 * These simulate external calendar and database state.
 */
const occupiedStartTimes = new Set<string>();

const bookingsByIdempotencyKey =
    new Map<string, ConfirmedBooking>();

/* -------------------------------------------------------------------------- */
/*                                    Tools                                   */
/* -------------------------------------------------------------------------- */

const tools: OpenAI.Responses.Tool[] = [
    {
        type: "function",
        name: "find_consultation_slots",
        description: "Find currently available consultation slots. This is read-only and does not reserve or create a booking. Call only when the timezone and supported duration are known.",
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    type: "string",
                    description:
                        "The user's IANA timezone, such as Europe/London.",
                },
                duration_minutes: {
                    type: "integer",
                    enum: [30, 45, 60, 90],
                    description:
                        "The requested consultation duration.",
                },
            },
            required: ["timezone", "duration_minutes"],
            additionalProperties: false,
        },
        strict: true,
    },
    {
        type: "function",
        name: "prepare_consultation_booking",
        description: "Prepare a pending booking after the user has selected an available slot and supplied their name and email. This does not create the real booking. It returns a summary that must be explicitly confirmed.",
        parameters: {
            type: "object",
            properties: {
                slot_id: {
                    type: "string",
                    description:
                        "The ID of a slot from the latest availability result.",
                },
                name: {
                    type: "string",
                    description: "The visitor's full name.",
                },
                email: {
                    type: "string",
                    description:
                        "The visitor's valid email address.",
                },
            },
            required: ["slot_id", "name", "email"],
            additionalProperties: false,
        },
        strict: true,
    },
    {
        type: "function",
        name: "book_consultation",
        description: "Create the real consultation booking. This is a write action. Call it only when the current application workflow state says the pending booking has been explicitly confirmed.",
        parameters: {
            type: "object",
            properties: {
                pending_booking_id: {
                    type: "string",
                    description:
                        "The UUID of the explicitly confirmed pending booking.",
                },
            },
            required: ["pending_booking_id"],
            additionalProperties: false,
        },
        strict: true,
    }
]

/* -------------------------------------------------------------------------- */
/*                              Tool implementations                          */
/* -------------------------------------------------------------------------- */

async function findConsultationSlots(
    args: z.infer<typeof FindSlotsArguments>,
): Promise<ToolResult> {
    const startTimes = [
        "2026-07-28T10:00:00+01:00",
        "2026-07-28T14:30:00+01:00",
        "2026-07-29T11:00:00+01:00",
    ];

    const slots: ConsultationSlot[] = startTimes
        .filter((startsAt) => !occupiedStartTimes.has(startsAt))
        .map((startsAt, index) => ({
            id: `slot_${args.duration_minutes}_${index + 1}`,
            starts_at: startsAt,
            timezone: args.timezone,
            duration_minutes: args.duration_minutes,
        }));

    workflow.availability = {
        checked_at: new Date().toISOString(),
        timezone: args.timezone,
        duration_minutes: args.duration_minutes,
        slots,
    };

    // A new search invalidates any unconfirmed selection.
    if (
        workflow.pending_booking &&
        workflow.pending_booking.status !== "booked"
    ) {
        workflow.pending_booking = null;
    }

    return {
        ok: true,
        checked_at: workflow.availability.checked_at,
        timezone: args.timezone,
        duration_minutes: args.duration_minutes,
        slots,
    };
}

async function prepareConsultationBooking(
  args: z.infer<typeof PrepareBookingArguments>,
): Promise<ToolResult> {
  const availability = workflow.availability;

  if (!availability) {
    return {
      ok: false,
      code: "AVAILABILITY_REQUIRED",
      message:
        "Availability must be checked before preparing a booking.",
    };
  }

  const slot = availability.slots.find(
    (candidate) => candidate.id === args.slot_id,
  );

  if (!slot) {
    return {
      ok: false,
      code: "INVALID_SLOT",
      message:
        "The selected slot is not part of the latest availability result.",
    };
  }

  if (occupiedStartTimes.has(slot.starts_at)) {
    return {
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message:
        "The selected slot is no longer available.",
      retryable: true,
    };
  }

  const normalisedEmail = args.email.trim().toLowerCase();

  const idempotencyKey = createHash("sha256")
    .update(
      [
        normalisedEmail,
        slot.starts_at,
        slot.duration_minutes,
      ].join("|"),
    )
    .digest("hex");

  workflow.pending_booking = {
    id: randomUUID(),
    slot_id: slot.id,
    starts_at: slot.starts_at,
    timezone: slot.timezone,
    duration_minutes: slot.duration_minutes,
    name: args.name.trim(),
    email: normalisedEmail,
    idempotency_key: idempotencyKey,
    status: "awaiting_confirmation",
  };

  return {
    ok: true,
    requires_confirmation: true,
    pending_booking_id: workflow.pending_booking.id,
    summary: {
      name: workflow.pending_booking.name,
      email: workflow.pending_booking.email,
      starts_at: workflow.pending_booking.starts_at,
      timezone: workflow.pending_booking.timezone,
      duration_minutes:
        workflow.pending_booking.duration_minutes,
    },
    confirmation_instruction:
      'Ask the user to reply with exactly "confirm" to create this booking, or "cancel" to discard it.',
  };
}

async function bookConsultation(
  args: z.infer<typeof BookConsultationArguments>,
): Promise<ToolResult> {
  const pending = workflow.pending_booking;

  if (!pending || pending.id !== args.pending_booking_id) {
    return {
      ok: false,
      code: "PENDING_BOOKING_NOT_FOUND",
      message:
        "The referenced pending booking does not exist.",
    };
  }

  /*
   * Idempotency check comes before attempting another write.
   */
  const existingBooking = bookingsByIdempotencyKey.get(
    pending.idempotency_key,
  );

  if (existingBooking) {
    workflow.last_booking = existingBooking;
    pending.status = "booked";

    return {
      ok: true,
      duplicate_prevented: true,
      booking: existingBooking,
    };
  }

  /*
   * The application, not the prompt, enforces confirmation.
   */
  if (pending.status !== "confirmed") {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message:
        "The user has not explicitly confirmed this booking.",
    };
  }

  /*
   * Recheck external state immediately before the write.
   */
  if (occupiedStartTimes.has(pending.starts_at)) {
    pending.status = "invalid";

    return {
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message:
        "The slot became unavailable before the booking was created.",
      retryable: true,
    };
  }

  const booking: ConfirmedBooking = {
    booking_id: randomUUID(),
    pending_booking_id: pending.id,
    slot_id: pending.slot_id,
    starts_at: pending.starts_at,
    timezone: pending.timezone,
    duration_minutes: pending.duration_minutes,
    name: pending.name,
    email: pending.email,
    status: "confirmed",
    created_at: new Date().toISOString(),
  };

  /*
   * Simulate the external calendar write.
   */
  occupiedStartTimes.add(pending.starts_at);

  /*
   * Simulate persistent storage using the same idempotency key.
   */
  bookingsByIdempotencyKey.set(
    pending.idempotency_key,
    booking,
  );

  pending.status = "booked";
  workflow.last_booking = booking;

  return {
    ok: true,
    duplicate_prevented: false,
    booking,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Tool dispatcher                               */
/* -------------------------------------------------------------------------- */

function invalidArguments(
  error: z.ZodError,
): ToolResult {
  return {
    ok: false,
    code: "INVALID_ARGUMENTS",
    message: error.message,
  };
}

async function executeTool(
  name: string,
  rawArguments: string,
): Promise<ToolResult> {
  let json: unknown;

  try {
    json = JSON.parse(rawArguments);
  } catch {
    return {
      ok: false,
      code: "INVALID_JSON",
      message:
        "The tool arguments were not valid JSON.",
    };
  }

  switch (name) {
    case "find_consultation_slots": {
      const parsed = FindSlotsArguments.safeParse(json);

      if (!parsed.success) {
        return invalidArguments(parsed.error);
      }

      return findConsultationSlots(parsed.data);
    }

    case "prepare_consultation_booking": {
      const parsed = PrepareBookingArguments.safeParse(json);

      if (!parsed.success) {
        return invalidArguments(parsed.error);
      }

      return prepareConsultationBooking(parsed.data);
    }

    case "book_consultation": {
      const parsed =
        BookConsultationArguments.safeParse(json);

      if (!parsed.success) {
        return invalidArguments(parsed.error);
      }

      return bookConsultation(parsed.data);
    }

    default:
      return {
        ok: false,
        code: "UNKNOWN_TOOL",
        message: `Unknown tool: ${name}`,
      };
  }
}

/* -------------------------------------------------------------------------- */
/*                        Deterministic confirmation                          */
/* -------------------------------------------------------------------------- */

function normaliseDecision(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
}

const acceptedConfirmations = new Set([
  "confirm",
  "yes, confirm",
  "confirm booking",
  "book it",
]);

const acceptedCancellations = new Set([
  "cancel",
  "cancel booking",
  "do not book",
  "don't book",
]);

function applyExplicitUserDecision(
  userMessage: string,
): void {
  const pending = workflow.pending_booking;

  if (
    !pending ||
    pending.status !== "awaiting_confirmation"
  ) {
    return;
  }

  const decision = normaliseDecision(userMessage);

  if (acceptedConfirmations.has(decision)) {
    pending.status = "confirmed";

    console.log(
      "\n[Application: explicit confirmation recorded]",
    );

    return;
  }

  if (acceptedCancellations.has(decision)) {
    workflow.pending_booking = null;

    console.log(
      "\n[Application: pending booking cancelled]",
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                          Model-visible state                               */
/* -------------------------------------------------------------------------- */

function getModelWorkflowState() {
  return {
    availability: workflow.availability,
    pending_booking: workflow.pending_booking
      ? {
          id: workflow.pending_booking.id,
          slot_id: workflow.pending_booking.slot_id,
          starts_at:
            workflow.pending_booking.starts_at,
          timezone: workflow.pending_booking.timezone,
          duration_minutes:
            workflow.pending_booking.duration_minutes,
          name: workflow.pending_booking.name,
          email: workflow.pending_booking.email,
          status: workflow.pending_booking.status,
        }
      : null,
    last_booking: workflow.last_booking,
  };
}

function buildInstructions(): string {
  return `
You are a consultation booking assistant.

You may help the user:
1. Find available consultation slots.
2. Select one available slot.
3. Collect their full name and email.
4. Prepare a pending booking.
5. Ask for explicit confirmation.
6. Create the booking only after application confirmation.

Supported durations:
- 30 minutes
- 45 minutes
- 60 minutes
- 90 minutes

Rules:
- Treat the application workflow state below as the source of truth.
- Never invent slot IDs, availability or booking success.
- Call find_consultation_slots only when timezone and duration are known.
- If the user selects a slot, collect any missing name or email.
- Call prepare_consultation_booking only when slot ID, name and email are known.
- After preparing a booking, show the exact summary and ask the user to reply with "confirm" or "cancel".
- Do not call book_consultation during the same turn in which the pending booking is prepared.
- Call book_consultation only when pending_booking.status is "confirmed".
- Vague statements such as "looks good", "okay" or "sure" are not explicit confirmation.
- Never claim a booking succeeded unless book_consultation returns ok: true.
- If the booking fails because the slot became unavailable, explain that plainly and offer to search again.
- If the user changes the slot, name or email before confirmation, prepare a new pending booking.
- Do not expose internal idempotency keys or implementation details.

Current application workflow state:
${JSON.stringify(getModelWorkflowState(), null, 2)}
  `.trim();
}

/* -------------------------------------------------------------------------- */
/*                              Agent loop                                    */
/* -------------------------------------------------------------------------- */

async function generateAssistantTurn(
  conversation: OpenAI.Responses.ResponseInputItem[],
): Promise<string> {
  for (let toolTurn = 0; toolTurn < 6; toolTurn += 1) {
    const response = await openai.responses.create({
      model,
      instructions: buildInstructions(),
      input: conversation,
      tools,
      parallel_tool_calls: false,
    });

    conversation.push(
      ...toResponseInputItems(response.output),
    );

    const toolCalls = response.output.filter(
      (item) => item.type === "function_call",
    );

    if (toolCalls.length === 0) {
      return response.output_text;
    }

    for (const toolCall of toolCalls) {
      console.log(
        `\n[Tool request: ${toolCall.name}]`,
      );
      console.log(
        `[Arguments: ${toolCall.arguments}]`,
      );

      const result = await executeTool(
        toolCall.name,
        toolCall.arguments,
      );

      console.log("[Tool result]", result);

      conversation.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  throw new Error(
    "Maximum tool-turn limit exceeded.",
  );
}

/* -------------------------------------------------------------------------- */
/*                         Developer test commands                            */
/* -------------------------------------------------------------------------- */

function simulateStaleSlot(): void {
  const pending = workflow.pending_booking;

  if (!pending) {
    console.log(
      "\n[No pending booking to make stale]",
    );
    return;
  }

  occupiedStartTimes.add(pending.starts_at);

  console.log(
    `\n[Simulation: ${pending.starts_at} is now occupied]`,
  );
}

async function simulateRetry(): Promise<void> {
  const pending = workflow.pending_booking;

  if (!pending) {
    console.log(
      "\n[No booking is available to retry]",
    );
    return;
  }

  const result = await bookConsultation({
    pending_booking_id: pending.id,
  });

  console.log("\n[Direct write retry result]", result);
}

/* -------------------------------------------------------------------------- */
/*                                   CLI                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const terminal = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const conversation:
    OpenAI.Responses.ResponseInputItem[] = [];

  console.log(`
Safe consultation assistant started.

Commands:
- confirm       Explicitly approve a pending booking
- cancel        Cancel a pending booking
- /stale        Simulate another person taking the slot
- /retry        Retry the previous booking write
- exit          Stop the program
  `.trim());

  try {
    while (true) {
      const userMessage =
        await terminal.question("\nYou: ");

      const normalised = userMessage
        .trim()
        .toLowerCase();

      if (normalised === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!normalised) {
        continue;
      }

      if (normalised === "/stale") {
        simulateStaleSlot();
        continue;
      }

      if (normalised === "/retry") {
        await simulateRetry();
        continue;
      }

      /*
       * Application confirmation happens before the model runs.
       */
      applyExplicitUserDecision(userMessage);

      conversation.push({
        role: "user",
        content: userMessage,
      });

      const assistantMessage =
        await generateAssistantTurn(conversation);

      console.log(
        `\nAssistant: ${assistantMessage}`,
      );
    }
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    error.name === "AbortError"
  ) {
    console.log("\nGoodbye.");
    process.exitCode = 0;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});