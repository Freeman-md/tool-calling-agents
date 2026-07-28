import { OpenAI } from "openai/client.js";

import type {
  ManualBookingService,
} from "../application/booking-service";

import {
  buildInstructions,
} from "./instructions";

import {
  createToolExecutor,
  manualBookingTools,
} from "./tools";

export type ManualTurnUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ManualTurnResult = {
  text: string;
  usage: ManualTurnUsage;
};

export class ManualBookingAssistant {
  private previousResponseId:
    string | undefined;

  private readonly executeTool:
    ReturnType<typeof createToolExecutor>;

  public constructor(
    private readonly openai: OpenAI,
    private readonly model: string,
    private readonly service:
      ManualBookingService,
    private readonly maxToolTurns = 6,
  ) {
    this.executeTool =
      createToolExecutor(service);
  }

  public async send(
    userMessage: string,
  ): Promise<ManualTurnResult> {
    const decision =
      this.service
        .recordExplicitDecision(
          userMessage,
        );

    if (decision === "confirmed") {
      console.log(
        "\n[Application: explicit confirmation recorded]",
      );
    }

    if (decision === "cancelled") {
      console.log(
        "\n[Application: pending booking cancelled]",
      );
    }

    let input:
      OpenAI.Responses.ResponseInputItem[] =
        [
          {
            role: "user",
            content: userMessage,
          },
        ];

    const usage: ManualTurnUsage = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    for (
      let toolTurn = 0;
      toolTurn < this.maxToolTurns;
      toolTurn += 1
    ) {
      const pending =
        this.service
          .getPendingBooking();

      const mustExecuteConfirmedBooking =
        pending?.status ===
        "confirmed";

      const response =
        await this.openai.responses.create(
          {
            model: this.model,

            instructions:
              buildInstructions(
                this.service,
              ),

            input,

            tools: manualBookingTools,

            parallel_tool_calls: false,

            tool_choice:
              mustExecuteConfirmedBooking
                ? {
                    type: "function",
                    name:
                      "book_consultation",
                  }
                : "auto",

            ...(this.previousResponseId
              ? {
                  previous_response_id:
                    this.previousResponseId,
                }
              : {}),
          },
        );

      this.previousResponseId =
        response.id;

      usage.requests += 1;

      if (response.usage) {
        usage.inputTokens +=
          response.usage.input_tokens;

        usage.outputTokens +=
          response.usage.output_tokens;

        usage.totalTokens +=
          response.usage.total_tokens;
      }

      const toolCalls =
        response.output.filter(
          (item) =>
            item.type ===
            "function_call",
        );

      if (toolCalls.length === 0) {
        const latestPending =
          this.service
            .getPendingBooking();

        if (
          latestPending?.status ===
          "confirmed"
        ) {
          throw new Error(
            "Invariant violated: confirmed booking was not executed.",
          );
        }

        return {
          text: response.output_text,
          usage,
        };
      }

      const toolOutputs:
        OpenAI.Responses.ResponseInputItem[] =
          [];

      for (
        const toolCall of toolCalls
      ) {
        console.log(
          `\n[Tool request: ${toolCall.name}]`,
        );

        console.log(
          `[Arguments: ${toolCall.arguments}]`,
        );

        const result =
          await this.executeTool(
            toolCall.name,
            toolCall.arguments,
          );

        console.log(
          "[Tool result]",
          result,
        );

        toolOutputs.push({
          type:
            "function_call_output",
          call_id:
            toolCall.call_id,
          output:
            JSON.stringify(result),
        });
      }

      /*
       * The next API call continues from
       * the previous response ID and sends
       * only the new tool outputs.
       */
      input = toolOutputs;
    }

    throw new Error(
      "Maximum tool-turn limit exceeded.",
    );
  }
}