import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin as inputStream, stdout as outputStream } from "node:process";
import { z } from "zod";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems.js";

const openai = new OpenAI();

const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

const FindSlotsArguments = z.object({
    timezone: z.string().min(1),
    duration_minutes: z.union([
        z.literal(30),
        z.literal(45),
        z.literal(60),
        z.literal(90),
    ]),
});

type ToolResult =
    | {
        ok: true;
        timezone: string;
        duration_minutes: number;
        slots: Array<{
            id: string;
            starts_at: string;
        }>;
    }
    | {
        ok: false;
        code: string;
        message: string;
    };

const tools: OpenAI.Responses.Tool[] = [
    {
        type: "function",
        name: "find_consultation_slots",
        description:
            "Find available consultation slots. This tool is read-only and must only be called once the user's timezone and preferred duration are known.",
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
                    description: "The requested consultation duration.",
                },
            },
            required: ["timezone", "duration_minutes"],
            additionalProperties: false,
        },
        strict: true,
    },
];

async function findConsultationSlots(
  args: z.infer<typeof FindSlotsArguments>,
): Promise<ToolResult> {
  return {
    ok: true,
    timezone: args.timezone,
    duration_minutes: args.duration_minutes,
    slots: [
      {
        id: "slot_001",
        starts_at: "2026-07-28T10:00:00+01:00",
      },
      {
        id: "slot_002",
        starts_at: "2026-07-28T14:30:00+01:00",
      },
      {
        id: "slot_003",
        starts_at: "2026-07-29T11:00:00+01:00",
      },
    ],
  };
}

async function executeTool(
    name: string,
    rawArguments: string
): Promise<ToolResult> {
    if (name !== "find_consultation_slots") {
        return {
            ok: false,
            code: "UNKNOWN_TOOL",
            message: `Unknown tool: ${name}`
        }
    }

    const parsed = FindSlotsArguments.safeParse(
        JSON.parse(rawArguments)
    )

    if (!parsed.success) {
        return {
            ok: false,
            code: "INVALID_ARGUMENTS",
            message: parsed.error.message
        }
    }

    return findConsultationSlots(parsed.data)
}

async function generateAssistantTurn(
  conversation: OpenAI.Responses.ResponseInputItem[],
): Promise<string> {
  for (let toolTurn = 0; toolTurn < 4; toolTurn += 1) {
    const response = await openai.responses.create({
      model,
      instructions: `
You are a consultation assistant.

Your job is to help the user find a consultation slot.

Required information:
- IANA timezone
- consultation duration: 30, 45, 60, or 90 minutes

Rules:
- Use information already supplied earlier in the conversation.
- Do not ask the user to repeat information they already provided.
- If required information is missing, ask one concise follow-up question.
- Once both fields are known, call find_consultation_slots.
- You can find availability, but you cannot create bookings.
- Never claim that a consultation has been booked.
      `.trim(),
      input: conversation,
      tools,
      parallel_tool_calls: false,
    });

    conversation.push(...toResponseInputItems(response.output));

    const toolCalls = response.output.filter(
      (item) => item.type === "function_call",
    );

    if (toolCalls.length === 0) {
      return response.output_text;
    }

    for (const toolCall of toolCalls) {
      console.log(`\n[Tool request: ${toolCall.name}]`);
      console.log(`[Arguments: ${toolCall.arguments}]`);

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
    "The assistant exceeded the maximum number of tool turns.",
  );
}

async function main() {
  const terminal = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  const conversation: OpenAI.Responses.ResponseInputItem[] = [];

  console.log(`
Consultation assistant started.

Type "exit" to stop.
  `.trim());

  try {
    while (true) {
      const userMessage = await terminal.question("\nYou: ");

      if (userMessage.trim().toLowerCase() === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!userMessage.trim()) {
        continue;
      }

      conversation.push({
        role: "user",
        content: userMessage,
      });

      const assistantMessage =
        await generateAssistantTurn(conversation);

      console.log(`\nAssistant: ${assistantMessage}`);
    }
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});