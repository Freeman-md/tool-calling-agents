import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import {
  stdin as inputStream,
  stdout as outputStream,
} from "node:process";

import {
  Agent,
  run,
  tool,
  user,
  type AgentInputItem,
} from "@openai/agents";
import { z } from "zod";

const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

/* -------------------------------------------------------------------------- */
/*                                   Schemas                                  */
/* -------------------------------------------------------------------------- */

const DurationSchema = z.union([
  z.literal(30),
  z.literal(45),
  z.literal(60),
  z.literal(90),
]);

const FindSlotsArguments = z.object({
  timezone: z.string().trim().min(1),
  duration_minutes: DurationSchema,
});

const BookConsultationArguments = z.object({
  slot_id: z.string().trim().min(1),
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
});

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

type ConfirmedBooking = {
  booking_id: string;
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
  last_booking: null,
};

// These simulate an external calendar and persistent database.
const occupiedStartTimes = new Set<string>();
const bookingsByIdempotencyKey =
  new Map<string, ConfirmedBooking>();

/* -------------------------------------------------------------------------- */
/*                             Domain operations                              */
/* -------------------------------------------------------------------------- */

function createSlotId(
  startsAt: string,
  durationMinutes: SupportedDuration,
): string {
  return createHash("sha256")
    .update(`${startsAt}|${durationMinutes}`)
    .digest("hex")
    .slice(0, 16);
}

async function findAvailableSlots(
  args: z.infer<typeof FindSlotsArguments>,
): Promise<ToolResult> {
  const startTimes = [
    "2026-07-28T10:00:00+01:00",
    "2026-07-28T14:30:00+01:00",
    "2026-07-29T11:00:00+01:00",
  ];

  const slots: ConsultationSlot[] = startTimes
    .filter(
      (startsAt) => !occupiedStartTimes.has(startsAt),
    )
    .map((startsAt) => ({
      id: createSlotId(
        startsAt,
        args.duration_minutes,
      ),
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

  return {
    ok: true,
    checked_at: workflow.availability.checked_at,
    timezone: args.timezone,
    duration_minutes: args.duration_minutes,
    slots,
  };
}

async function createBooking(
  args: z.infer<typeof BookConsultationArguments>,
): Promise<ToolResult> {
  const availability = workflow.availability;

  if (!availability) {
    return {
      ok: false,
      code: "AVAILABILITY_REQUIRED",
      message:
        "Availability must be checked before creating a booking.",
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

  const normalisedEmail = args.email
    .trim()
    .toLowerCase();

  const idempotencyKey = createHash("sha256")
    .update(
      [
        normalisedEmail,
        slot.starts_at,
        slot.duration_minutes,
      ].join("|"),
    )
    .digest("hex");

  const existingBooking =
    bookingsByIdempotencyKey.get(idempotencyKey);

  if (existingBooking) {
    workflow.last_booking = existingBooking;

    return {
      ok: true,
      duplicate_prevented: true,
      booking: existingBooking,
    };
  }

  // Recheck external state immediately before the write.
  if (occupiedStartTimes.has(slot.starts_at)) {
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
    slot_id: slot.id,
    starts_at: slot.starts_at,
    timezone: slot.timezone,
    duration_minutes: slot.duration_minutes,
    name: args.name.trim(),
    email: normalisedEmail,
    status: "confirmed",
    created_at: new Date().toISOString(),
  };

  // Simulate the external calendar write.
  occupiedStartTimes.add(slot.starts_at);

  // Simulate durable storage protected by a unique idempotency key.
  bookingsByIdempotencyKey.set(
    idempotencyKey,
    booking,
  );

  workflow.last_booking = booking;

  return {
    ok: true,
    duplicate_prevented: false,
    booking,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  SDK tools                                 */
/* -------------------------------------------------------------------------- */

const findConsultationSlots = tool({
  name: "find_consultation_slots",
  description:
    "Find currently available consultation slots. This is read-only and does not reserve or create a booking. Use it only when the user's timezone and supported duration are known.",
  parameters: FindSlotsArguments,
  execute: async (args) => {
    console.log(
      "\n[SDK executing find_consultation_slots]",
    );
    console.log(args);

    return findAvailableSlots(args);
  },
});

const bookConsultation = tool({
  name: "book_consultation",
  description:
    "Create a real consultation booking for a slot from the latest availability result. This is a write action and always requires explicit human approval before execution.",
  parameters: BookConsultationArguments,
  needsApproval: true,
  execute: async (args) => {
    console.log(
      "\n[SDK executing book_consultation]",
    );
    console.log(args);

    return createBooking(args);
  },
});

/* -------------------------------------------------------------------------- */
/*                                  Agent                                     */
/* -------------------------------------------------------------------------- */

function getModelWorkflowState() {
  return {
    availability: workflow.availability,
    last_booking: workflow.last_booking,
  };
}

function buildInstructions(): string {
  return `
You are a consultation booking assistant.

You help users:
1. Find consultation availability.
2. Select an available slot.
3. Provide their full name and email address.
4. Request creation of the booking.

Supported durations:
- 30 minutes
- 45 minutes
- 60 minutes
- 90 minutes

Rules:
- Treat the application workflow state below as the source of truth.
- Reuse information already supplied earlier in the conversation.
- Do not ask users to repeat details they already provided.
- Convert clear timezone phrases such as "London time" into an IANA timezone such as "Europe/London".
- If timezone or duration is missing, ask one concise follow-up question.
- Once timezone and duration are known, call find_consultation_slots.
- Never invent availability or slot IDs.
- When the user selects a slot, collect any missing full name or email address.
- Once slot ID, name and email are known, call book_consultation.
- Do not ask for conversational confirmation before calling book_consultation. The application will show a separate approval checkpoint before the write executes.
- Never claim a booking succeeded unless book_consultation returns ok: true.
- If approval is rejected, explain that the booking was cancelled and no write occurred.
- If the slot becomes unavailable, explain that plainly and offer to search again.
- Do not expose idempotency keys or internal implementation details.

Current application workflow state:
${JSON.stringify(getModelWorkflowState(), null, 2)}
  `.trim();
}

const consultationAgent = new Agent({
  name: "Consultation booking assistant",
  model,
  instructions: () => buildInstructions(),
  tools: [
    findConsultationSlots,
    bookConsultation,
  ],
  modelSettings: {
    parallelToolCalls: false,
  },
});

/* -------------------------------------------------------------------------- */
/*                             Approval helpers                               */
/* -------------------------------------------------------------------------- */

function normaliseDecision(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
}

function parseBookingArguments(
  rawArguments: string,
): z.infer<typeof BookConsultationArguments> | null {
  try {
    const parsed = BookConsultationArguments.safeParse(
      JSON.parse(rawArguments),
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function findSlotById(
  slotId: string,
): ConsultationSlot | null {
  return (
    workflow.availability?.slots.find(
      (slot) => slot.id === slotId,
    ) ?? null
  );
}

function printApprovalSummary(
  args: z.infer<typeof BookConsultationArguments>,
  slot: ConsultationSlot,
): void {
  console.log(`
[Approval required]
Name: ${args.name}
Email: ${args.email}
Starts: ${slot.starts_at}
Timezone: ${slot.timezone}
Duration: ${slot.duration_minutes} minutes

Type "confirm" to approve, "cancel" to reject, or "/stale" to simulate the slot being taken before approval.`);
}

function simulateStaleSlot(
  slot: ConsultationSlot,
): void {
  occupiedStartTimes.add(slot.starts_at);

  console.log(
    `\n[Simulation: ${slot.starts_at} is now occupied]`,
  );
}

async function retryLastBooking(): Promise<void> {
  const booking = workflow.last_booking;

  if (!booking) {
    console.log(
      "\n[No successful booking is available to retry]",
    );
    return;
  }

  const result = await createBooking({
    slot_id: booking.slot_id,
    name: booking.name,
    email: booking.email,
  });

  console.log(
    "\n[Direct idempotent retry result]",
    result,
  );
}

/* -------------------------------------------------------------------------- */
/*                                    CLI                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const terminal = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  let history: AgentInputItem[] = [];

  console.log(`
Agents SDK consultation booking assistant started.

Commands:
- /retry       Retry the last successful booking write
- /state       Inspect current application workflow state
- exit         Stop the program
  `.trim());

  try {
    while (true) {
      const message =
        await terminal.question("\nYou: ");

      const normalised = normaliseDecision(message);

      if (normalised === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!normalised) {
        continue;
      }

      if (normalised === "/retry") {
        await retryLastBooking();
        continue;
      }

      if (normalised === "/state") {
        console.dir(workflow, { depth: null });
        continue;
      }

      history.push(user(message));

      let result = await run(
        consultationAgent,
        history,
        {
          maxTurns: 8,
        },
      );

      while (result.interruptions.length > 0) {
        for (const interruption of result.interruptions) {
          if (
            interruption.name !== "book_consultation"
          ) {
            result.state.reject(interruption, {
              message:
                "This tool call was not approved by the application.",
            });
            continue;
          }

          const args = parseBookingArguments(
            interruption.arguments,
          );
          const slot = args
            ? findSlotById(args.slot_id)
            : null;

          if (!args || !slot) {
            result.state.reject(interruption, {
              message:
                "The booking request could not be verified against the latest availability result.",
            });
            continue;
          }

          printApprovalSummary(args, slot);

          while (true) {
            const decision = normaliseDecision(
              await terminal.question(
                "\nApproval: ",
              ),
            );

            if (
              decision === "confirm" ||
              decision === "yes, confirm"
            ) {
              result.state.approve(interruption);
              console.log(
                "\n[Application: booking tool approved]",
              );
              break;
            }

            if (
              decision === "cancel" ||
              decision === "reject"
            ) {
              result.state.reject(interruption, {
                message:
                  "The user cancelled the booking. No booking was created.",
              });
              console.log(
                "\n[Application: booking tool rejected]",
              );
              break;
            }

            if (decision === "/stale") {
              simulateStaleSlot(slot);
              continue;
            }

            console.log(
              'Please type "confirm", "cancel", or "/stale".',
            );
          }
        }

        // Resume from the exact interrupted SDK run state.
        result = await run(
          consultationAgent,
          result.state,
          {
            maxTurns: 8,
          },
        );
      }

      history = result.history;

      console.log(
        `\nAssistant: ${result.finalOutput}`,
      );

      console.log("\n[Run usage]", {
        requests: result.state.usage.requests,
        inputTokens:
          result.state.usage.inputTokens,
        outputTokens:
          result.state.usage.outputTokens,
        totalTokens:
          result.state.usage.totalTokens,
      });
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
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
