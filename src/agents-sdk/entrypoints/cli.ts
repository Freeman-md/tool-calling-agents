import readline from "node:readline/promises";

import {
  stdin as inputStream,
  stdout as outputStream,
} from "node:process";

import {
  Runner,
} from "@openai/agents";

import {
  AgentsBookingService,
} from "../application/booking-service";

import {
  InMemoryBookingRepository,
  InMemoryCalendarGateway,
} from "../infrastructure/in-memory";

import {
  createConsultationAgent,
} from "../orchestration/agent";

import {
  AgentsBookingSession,
  type ApprovalHandler,
} from "../orchestration/session";

const model =
  process.env.OPENAI_MODEL ??
  "gpt-4.1-mini";

function normaliseDecision(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
}

async function main(): Promise<void> {
  const calendar =
    new InMemoryCalendarGateway();

  const bookingRepository =
    new InMemoryBookingRepository();

  const service =
    new AgentsBookingService(
      calendar,
      bookingRepository,
    );

  const agent =
    createConsultationAgent(
      service,
      model,
    );

  /*
   * The Runner belongs to the process,
   * not to an individual request.
   */
  const runner = new Runner();

  /*
   * Create one session per conversation
   * or per authenticated user.
   */
  const session =
    new AgentsBookingSession(
      agent,
      service,
      runner,
    );

  const terminal =
    readline.createInterface({
      input: inputStream,
      output: outputStream,
    });

  const approvalHandler:
    ApprovalHandler =
      async (request) => {
        console.log(`
[Approval required]
Name: ${request.arguments.name}
Email: ${request.arguments.email}
Starts: ${request.slot.starts_at}
Timezone: ${request.slot.timezone}
Duration: ${request.slot.duration_minutes} minutes

Type "confirm" to approve, "cancel" to reject, or "/stale" to simulate the slot being taken before approval.
        `.trim());

        while (true) {
          const decision =
            normaliseDecision(
              await terminal.question(
                "\nApproval: ",
              ),
            );

          if (
            decision === "confirm" ||
            decision ===
              "yes, confirm"
          ) {
            console.log(
              "\n[Application: booking tool approved]",
            );

            return {
              approved: true,
            };
          }

          if (
            decision === "cancel" ||
            decision === "reject"
          ) {
            console.log(
              "\n[Application: booking tool rejected]",
            );

            return {
              approved: false,
              message:
                "The user cancelled the booking. No booking was created.",
            };
          }

          if (decision === "/stale") {
            const simulated =
              await service
                .simulateStaleSlot(
                  request.slot.id,
                );

            console.log(
              simulated
                ? `\n[Simulation: ${request.slot.starts_at} is now occupied]`
                : "\n[The selected slot could not be found]",
            );

            continue;
          }

          console.log(
            'Please type "confirm", "cancel", or "/stale".',
          );
        }
      };

  console.log(`
Agents SDK consultation booking assistant started.

Commands:
- /retry       Retry the last successful booking write
- /state       Inspect application workflow state
- /reset       Clear conversation history
- exit         Stop the program
  `.trim());

  try {
    while (true) {
      const message =
        await terminal.question(
          "\nYou: ",
        );

      const command =
        normaliseDecision(message);

      if (command === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!command) {
        continue;
      }

      if (command === "/retry") {
        const result =
          await service
            .retryLastBooking();

        console.log(
          "\n[Direct idempotent retry result]",
          result,
        );

        continue;
      }

      if (command === "/state") {
        console.dir(
          service.getWorkflowState(),
          {
            depth: null,
          },
        );

        continue;
      }

      if (command === "/reset") {
        session.reset();

        console.log(
          "\n[Conversation history cleared]",
        );

        continue;
      }

      const result =
        await session.send(
          message,
          approvalHandler,
        );

      console.log(
        `\nAssistant: ${result.text}`,
      );

      console.log(
        "\n[Run usage]",
        result.usage,
      );
    }
  } finally {
    terminal.close();
  }
}

main().catch(
  (error: unknown) => {
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
  },
);