import readline from "node:readline/promises";
import {
  stdin as inputStream,
  stdout as outputStream,
} from "node:process";
import { Agent, tool, run, user, type AgentInputItem } from '@openai/agents'
import { z } from 'zod'

const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

const FindSlotsArguments = z.object({
    timezone: z.string().trim().min(1),
    duration_minutes: z.union([
        z.literal(30),
        z.literal(45),
        z.literal(60),
        z.literal(90),
    ])
})

const findConsultationSlots = tool({
    name: "find_consultation_tools",
    description: "Find available consultation slots. This is read-only and does not create or reserve a booking. Use it only when the user's timezone and supported duration are known.",
    parameters: FindSlotsArguments,
    execute: async ({
        timezone,
        duration_minutes
    }) => {
        console.log(
            "\n[SDK executing find_consultation_slots]",
        );

        console.log({
            timezone,
            duration_minutes,
        });

        return {
            ok: true,
            checked_at: new Date().toISOString(),
            timezone,
            duration_minutes,
            slots: [
                {
                    id: "slot_001",
                    starts_at:
                        "2026-07-28T10:00:00+01:00",
                },
                {
                    id: "slot_002",
                    starts_at:
                        "2026-07-28T14:30:00+01:00",
                },
                {
                    id: "slot_003",
                    starts_at:
                        "2026-07-29T11:00:00+01:00",
                },
            ],
        };
    }
})

const consultationAgent = new Agent({
    name: "Consultation availability assistant",
    model,

    instructions: `
You help visitors find consultation availability.

Required information:
- consultation duration: 30, 45, 60, or 90 minutes
- the user's timezone

Rules:
- Use information already supplied earlier in the conversation.
- Do not ask users to repeat information they already provided.
- Convert clear timezone phrases such as "London time" into an IANA timezone such as "Europe/London".
- If required information is missing, ask one concise follow-up question.
- Once the timezone and duration are known, use find_consultation_slots.
- Never invent availability.
- You can search availability, but you cannot reserve or create bookings.
- Never claim that a booking has been made.
  `.trim(),
    tools: [findConsultationSlots]
})

async function main() {
  const terminal = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });

  let history: AgentInputItem[] = [];

  console.log(`
Agents SDK consultation assistant started.

Type "exit" to stop.
  `.trim());

  try {
    while (true) {
      const message =
        await terminal.question("\nYou: ");

      const normalised = message
        .trim()
        .toLowerCase();

      if (normalised === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!normalised) {
        continue;
      }

      history.push(user(message));

      const result = await run(
        consultationAgent,
        history,
        {
          maxTurns: 6,
        },
      );

      /*
       * Contains the previous history plus the model messages,
       * tool requests and tool outputs from this run.
       */
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