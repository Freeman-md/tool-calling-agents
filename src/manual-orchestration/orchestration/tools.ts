import type { OpenAI } from "openai/client.js";
import { z } from "zod";

import {
  BookConsultationArguments,
  FindSlotsArguments,
  PrepareBookingArguments,
} from "../domain/schemas";

import type { ToolResult } from "../domain/types";

import type {
  ManualBookingService,
} from "../application/booking-service";

export const manualBookingTools:
  OpenAI.Responses.Tool[] = [
    {
      type: "function",
      name:
        "find_consultation_slots",
      description:
        "Find currently available consultation slots. This is read-only and does not reserve or create a booking. Call only when timezone and supported duration are known.",
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
        required: [
          "timezone",
          "duration_minutes",
        ],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name:
        "prepare_consultation_booking",
      description:
        "Prepare a pending booking after the user selects an available slot and provides their name and email. This does not create the real booking.",
      parameters: {
        type: "object",
        properties: {
          slot_id: {
            type: "string",
            description:
              "A slot ID from the latest availability result.",
          },
          name: {
            type: "string",
            description:
              "The visitor's full name.",
          },
          email: {
            type: "string",
            description:
              "The visitor's valid email address.",
          },
        },
        required: [
          "slot_id",
          "name",
          "email",
        ],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "book_consultation",
      description:
        "Create the real consultation booking. Call only when application state says the pending booking has been explicitly confirmed.",
      parameters: {
        type: "object",
        properties: {
          pending_booking_id: {
            type: "string",
            description:
              "The UUID of the explicitly confirmed pending booking.",
          },
        },
        required: [
          "pending_booking_id",
        ],
        additionalProperties: false,
      },
      strict: true,
    },
  ];

function invalidArguments(
  error: z.ZodError,
): ToolResult {
  return {
    ok: false,
    code: "INVALID_ARGUMENTS",
    message: error.message,
  };
}

export function createToolExecutor(
  service: ManualBookingService,
) {
  return async function executeTool(
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
        const parsed =
          FindSlotsArguments.safeParse(
            json,
          );

        if (!parsed.success) {
          return invalidArguments(
            parsed.error,
          );
        }

        return service.findSlots(
          parsed.data,
        );
      }

      case
        "prepare_consultation_booking": {
        const parsed =
          PrepareBookingArguments.safeParse(
            json,
          );

        if (!parsed.success) {
          return invalidArguments(
            parsed.error,
          );
        }

        return service.prepareBooking(
          parsed.data,
        );
      }

      case "book_consultation": {
        const parsed =
          BookConsultationArguments.safeParse(
            json,
          );

        if (!parsed.success) {
          return invalidArguments(
            parsed.error,
          );
        }

        return service.bookConsultation(
          parsed.data,
        );
      }

      default:
        return {
          ok: false,
          code: "UNKNOWN_TOOL",
          message:
            `Unknown tool: ${name}`,
        };
    }
  };
}