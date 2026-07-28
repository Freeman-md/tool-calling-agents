import {
  Runner,
  user,
  type AgentInputItem,
} from "@openai/agents";

import {
  BookConsultationArguments,
  type BookConsultationInput,
} from "../domain/schemas";

import type {
  ConsultationSlot,
} from "../domain/types";

import type {
  AgentsBookingService,
} from "../application/booking-service";

import type {
  ConsultationAgent,
} from "./agent";

export type BookingApprovalRequest = {
  toolName: "book_consultation";
  arguments: BookConsultationInput;
  slot: ConsultationSlot;
};

export type ApprovalDecision =
  | {
      approved: true;
    }
  | {
      approved: false;
      message?: string;
    };

export type ApprovalHandler = (
  request: BookingApprovalRequest,
) => Promise<ApprovalDecision>;

export type AgentsTurnUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentsTurnResult = {
  text: string;
  usage: AgentsTurnUsage;
};

function parseBookingArguments(
  rawArguments: string,
): BookConsultationInput | null {
  try {
    const parsed =
      BookConsultationArguments
        .safeParse(
          JSON.parse(rawArguments),
        );

    return parsed.success
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export class AgentsBookingSession {
  private history:
    AgentInputItem[] = [];

  public constructor(
    private readonly agent:
      ConsultationAgent,

    private readonly service:
      AgentsBookingService,

    /*
     * Create one Runner when the application
     * starts and reuse it for this session.
     */
    private readonly runner:
      Runner = new Runner(),

    private readonly maxTurns = 8,
  ) {}

  public async send(
    message: string,
    approvalHandler: ApprovalHandler,
  ): Promise<AgentsTurnResult> {
    this.history.push(user(message));

    let result =
      await this.runner.run(
        this.agent,
        this.history,
        {
          maxTurns: this.maxTurns,
        },
      );

    while (
      result.interruptions.length > 0
    ) {
      for (
        const interruption
        of result.interruptions
      ) {
        if (
          interruption.name !==
          "book_consultation"
        ) {
          result.state.reject(
            interruption,
            {
              message:
                "This tool call was not approved by the application.",
            },
          );

          continue;
        }

        const args =
          parseBookingArguments(
            interruption.arguments ??
              "",
          );

        const slot = args
          ? this.service.findSlotById(
              args.slot_id,
            )
          : null;

        /*
         * The model's proposal must be
         * validated against application state
         * before it is shown for approval.
         */
        if (!args || !slot) {
          result.state.reject(
            interruption,
            {
              message:
                "The booking request could not be verified against the latest availability result.",
            },
          );

          continue;
        }

        const decision =
          await approvalHandler({
            toolName:
              "book_consultation",
            arguments: args,
            slot,
          });

        if (decision.approved) {
          result.state.approve(
            interruption,
          );
        } else {
          result.state.reject(
            interruption,
            {
              message:
                decision.message ??
                "The booking was rejected. No booking was created.",
            },
          );
        }
      }

      /*
       * Resume the exact SDK run that produced
       * the interruption.
       */
      result =
        await this.runner.run(
          this.agent,
          result.state,
          {
            maxTurns:
              this.maxTurns,
          },
        );
    }

    this.history = result.history;

    return {
      text:
        typeof result.finalOutput ===
        "string"
          ? result.finalOutput
          : JSON.stringify(
              result.finalOutput,
            ),

      usage: {
        requests:
          result.state.usage.requests,

        inputTokens:
          result.state.usage
            .inputTokens,

        outputTokens:
          result.state.usage
            .outputTokens,

        totalTokens:
          result.state.usage
            .totalTokens,
      },
    };
  }

  public reset(): void {
    this.history = [];
  }
}