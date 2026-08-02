import {
  OpenAI,
} from "openai/client.js";

import type {
  ManualBookingService,
} from "../application/booking-service";

import type {
  CalendlyMcpBridge,
  CalendlyMcpResult,
} from "../infrastructure/calendly-mcp/calendly-mcp-bridge";

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

type PendingCalendlyApproval = {
  responseId: string;
  callId: string;
  toolName: string;
  arguments: string;
};

export class ManualBookingAssistant {
  private previousResponseId:
    string | undefined;

  private pendingCalendlyApproval:
    PendingCalendlyApproval |
    undefined;

  private readonly executeLocalTool:
    ReturnType<
      typeof createToolExecutor
    >;

  public constructor(
    private readonly openai: OpenAI,
    private readonly model: string,
    private readonly service:
      ManualBookingService,
    private readonly calendly:
      CalendlyMcpBridge,
    private readonly maxToolTurns = 6,
  ) {
    this.executeLocalTool =
      createToolExecutor(service);
  }

  public async send(
    userMessage: string,
  ): Promise<ManualTurnResult> {
    if (
      this.pendingCalendlyApproval
    ) {
      return this.handlePendingApproval(
        userMessage,
      );
    }

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

    return this.run([
      {
        role: "user",
        content: userMessage,
      },
    ]);
  }

  private async handlePendingApproval(
    userMessage: string,
  ): Promise<ManualTurnResult> {
    const pending =
      this.pendingCalendlyApproval;

    if (!pending) {
      throw new Error(
        "No Calendly approval is pending.",
      );
    }

    const decision =
      userMessage
        .trim()
        .toLowerCase();

    const approved =
      decision === "confirm" ||
      decision === "approve" ||
      decision === "yes";

    const rejected =
      decision === "cancel" ||
      decision === "reject" ||
      decision === "no";

    if (!approved && !rejected) {
      return {
        text:
          this.renderCalendlyApproval(
            pending,
          ),

        usage:
          this.emptyUsage(),
      };
    }

    this.pendingCalendlyApproval =
      undefined;

    this.previousResponseId =
      pending.responseId;

    const result:
      CalendlyMcpResult =
        approved
          ? await this.calendly
              .execute(
                pending.toolName,
                pending.arguments,
              )
          : {
              ok: false,
              content:
                "The visitor cancelled the booking.",
            };

    return this.run([
      {
        type:
          "function_call_output",

        call_id:
          pending.callId,

        output:
          JSON.stringify(result),
      },
    ]);
  }

  private async run(
    initialInput:
      OpenAI.Responses.ResponseInputItem[],
  ): Promise<ManualTurnResult> {
    let input = initialInput;

    const usage =
      this.emptyUsage();

    for (
      let toolTurn = 0;
      toolTurn <
        this.maxToolTurns;
      toolTurn += 1
    ) {
      const pendingBooking =
        this.service
          .getPendingBooking();

      const mustExecuteConfirmedBooking =
        pendingBooking?.status ===
        "confirmed";

      const response =
        await this.openai
          .responses
          .create({
            model:
              this.model,

            instructions:
              buildInstructions(
                this.service,
              ),

            input,

            tools: [
              ...manualBookingTools,
              ...this.calendly.tools,
            ],

            parallel_tool_calls:
              false,

            tool_choice:
              mustExecuteConfirmedBooking
                ? {
                    type:
                      "function",

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
          });

      this.previousResponseId =
        response.id;

      usage.requests += 1;

      if (response.usage) {
        usage.inputTokens +=
          response.usage
            .input_tokens;

        usage.outputTokens +=
          response.usage
            .output_tokens;

        usage.totalTokens +=
          response.usage
            .total_tokens;
      }

      const toolCalls =
        response.output.filter(
          (item) =>
            item.type ===
            "function_call",
        );

      if (
        toolCalls.length === 0
      ) {
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
          text:
            response.output_text,

          usage,
        };
      }

      const toolOutputs:
        OpenAI.Responses.ResponseInputItem[] =
          [];

      for (
        const toolCall
        of toolCalls
      ) {
        console.log(
          `\n[Tool request: ${toolCall.name}]`,
        );

        console.log(
          `[Arguments: ${toolCall.arguments}]`,
        );

        if (
          this.calendly
            .ownsTool(
              toolCall.name,
            )
        ) {
          if (
            this.calendly
              .requiresApproval(
                toolCall.name,
              )
          ) {
            this.pendingCalendlyApproval =
              {
                responseId:
                  response.id,

                callId:
                  toolCall.call_id,

                toolName:
                  toolCall.name,

                arguments:
                  toolCall.arguments,
              };

            return {
              text:
                this.renderCalendlyApproval(
                  this
                    .pendingCalendlyApproval,
                ),

              usage,
            };
          }

          const result =
            await this.calendly
              .execute(
                toolCall.name,
                toolCall.arguments,
              );

          toolOutputs.push({
            type:
              "function_call_output",

            call_id:
              toolCall.call_id,

            output:
              JSON.stringify(
                result,
              ),
          });

          continue;
        }

        const result =
          await this.executeLocalTool(
            toolCall.name,
            toolCall.arguments,
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

      input = toolOutputs;
    }

    throw new Error(
      "Maximum tool-turn limit exceeded.",
    );
  }

  private renderCalendlyApproval(
    pending:
      PendingCalendlyApproval,
  ): string {
    let details =
      pending.arguments;

    try {
      details =
        JSON.stringify(
          JSON.parse(
            pending.arguments,
          ),
          null,
          2,
        );
    } catch {
      // Preserve the original value.
    }

    return `
Please confirm this Calendly booking.

${details}

Reply CONFIRM to create the booking,
or CANCEL to stop.
`.trim();
  }

  private emptyUsage():
    ManualTurnUsage {
    return {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }
}