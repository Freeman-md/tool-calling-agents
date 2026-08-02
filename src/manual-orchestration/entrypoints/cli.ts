import readline from "node:readline/promises";

import {
  stdin as inputStream,
  stdout as outputStream,
} from "node:process";

import { OpenAI } from "openai/client.js";

import {
  ManualBookingService,
} from "../application/booking-service";

import {
  InMemoryBookingRepository,
  InMemoryCalendarGateway,
} from "../infrastructure/in-memory";

import {
  connectCalendlyMcp,
} from "../infrastructure/calendly-mcp/calendly-mcp-client";

import {
  CalendlyMcpBridge,
} from "../infrastructure/calendly-mcp/calendly-mcp-bridge";

import {
  ManualBookingAssistant,
} from "../orchestration/assistant";

const model =
  process.env.OPENAI_MODEL ??
  "gpt-4.1-mini";

function normaliseCommand(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase();
}

async function main(): Promise<void> {
  /*
   * Dependency composition belongs at the
   * application boundary.
   */
  const calendar =
    new InMemoryCalendarGateway();

  const calendlyConnection =
    await connectCalendlyMcp();

  const calendlyBridge =
    await CalendlyMcpBridge.create(
      calendlyConnection.client,
    );

  const bookingRepository =
    new InMemoryBookingRepository();

  const service =
    new ManualBookingService(
      calendar,
      bookingRepository,
    );

  const assistant =
    new ManualBookingAssistant(
      new OpenAI(),
      model,
      service,
      calendlyBridge
    );

  const terminal =
    readline.createInterface({
      input: inputStream,
      output: outputStream,
    });

  console.log(`
Manual Responses booking assistant started.

Commands:
- /stale       Simulate another person taking the pending slot
- /retry       Retry the previous booking write
- /state       Inspect workflow state
- exit         Stop the program
  `.trim());

  try {
    while (true) {
      const message =
        await terminal.question(
          "\nYou: ",
        );

      const command =
        normaliseCommand(message);

      if (command === "exit") {
        console.log("Goodbye.");
        return;
      }

      if (!command) {
        continue;
      }

      if (command === "/stale") {
        const simulated =
          await service
            .simulateStalePendingSlot();

        console.log(
          simulated
            ? "\n[Pending slot is now occupied]"
            : "\n[No pending booking to make stale]",
        );

        continue;
      }

      if (command === "/retry") {
        const result =
          await service
            .retryPendingBooking();

        console.log(
          "\n[Direct write retry result]",
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

      const result =
        await assistant.send(message);

      console.log(
        `\nAssistant: ${result.text}`,
      );

      console.log(
        "\n[Turn usage]",
        result.usage,
      );
    }
  } finally {
    await calendlyConnection.close();

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