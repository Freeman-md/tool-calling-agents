import {
  createHash,
  randomUUID,
} from "node:crypto";

import type {
  BookConsultationInput,
  FindSlotsInput,
  PrepareBookingInput,
} from "../domain/schemas";

import type {
  BookingRepository,
  CalendarGateway,
  ConfirmedBooking,
  ConsultationSlot,
  ManualWorkflowState,
  PendingBooking,
  SupportedDuration,
  UserDecisionResult,
  ToolResult,
} from "../domain/types";

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

function normaliseDecision(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
}

function createSlotId(
  startsAt: string,
  durationMinutes: SupportedDuration,
): string {
  return createHash("sha256")
    .update(
      `${startsAt}|${durationMinutes}`,
    )
    .digest("hex")
    .slice(0, 16);
}

function createIdempotencyKey(
  email: string,
  startsAt: string,
  durationMinutes: SupportedDuration,
): string {
  return createHash("sha256")
    .update(
      [
        email,
        startsAt,
        durationMinutes,
      ].join("|"),
    )
    .digest("hex");
}

export class ManualBookingService {
  private readonly workflow:
    ManualWorkflowState = {
      availability: null,
      pending_booking: null,
      last_booking: null,
    };

  public constructor(
    private readonly calendar:
      CalendarGateway,
    private readonly bookingRepository:
      BookingRepository,
  ) {}

  public getWorkflowState():
    ManualWorkflowState {
    return structuredClone(this.workflow);
  }

  public getModelWorkflowState() {
    const pending =
      this.workflow.pending_booking;

    return {
      availability:
        this.workflow.availability,

      pending_booking: pending
        ? {
            id: pending.id,
            slot_id: pending.slot_id,
            starts_at: pending.starts_at,
            timezone: pending.timezone,
            duration_minutes:
              pending.duration_minutes,
            name: pending.name,
            email: pending.email,
            status: pending.status,
          }
        : null,

      last_booking:
        this.workflow.last_booking,
    };
  }

  public getPendingBooking():
    PendingBooking | null {
    return this.workflow.pending_booking
      ? structuredClone(
          this.workflow.pending_booking,
        )
      : null;
  }

  public async findSlots(
    input: FindSlotsInput,
  ): Promise<ToolResult> {
    const startTimes =
      await this.calendar.listStartTimes();

    const slots: ConsultationSlot[] = [];

    for (const startsAt of startTimes) {
      const occupied =
        await this.calendar.isOccupied(
          startsAt,
        );

      if (occupied) {
        continue;
      }

      slots.push({
        id: createSlotId(
          startsAt,
          input.duration_minutes,
        ),
        starts_at: startsAt,
        timezone: input.timezone,
        duration_minutes:
          input.duration_minutes,
      });
    }

    this.workflow.availability = {
      checked_at: new Date().toISOString(),
      timezone: input.timezone,
      duration_minutes:
        input.duration_minutes,
      slots,
    };

    /*
     * A new availability search invalidates
     * an uncompleted selection.
     */
    if (
      this.workflow.pending_booking &&
      this.workflow.pending_booking.status !==
        "booked"
    ) {
      this.workflow.pending_booking = null;
    }

    return {
      ok: true,
      checked_at:
        this.workflow.availability
          .checked_at,
      timezone: input.timezone,
      duration_minutes:
        input.duration_minutes,
      slots,
    };
  }

  public async prepareBooking(
    input: PrepareBookingInput,
  ): Promise<ToolResult> {
    const availability =
      this.workflow.availability;

    if (!availability) {
      return {
        ok: false,
        code: "AVAILABILITY_REQUIRED",
        message:
          "Availability must be checked before preparing a booking.",
      };
    }

    const slot = availability.slots.find(
      (candidate) =>
        candidate.id === input.slot_id,
    );

    if (!slot) {
      return {
        ok: false,
        code: "INVALID_SLOT",
        message:
          "The selected slot is not part of the latest availability result.",
      };
    }

    const occupied =
      await this.calendar.isOccupied(
        slot.starts_at,
      );

    if (occupied) {
      return {
        ok: false,
        code: "SLOT_UNAVAILABLE",
        message:
          "The selected slot is no longer available.",
        retryable: true,
      };
    }

    const normalisedEmail = input.email
      .trim()
      .toLowerCase();

    const pendingBooking:
      PendingBooking = {
        id: randomUUID(),
        slot_id: slot.id,
        starts_at: slot.starts_at,
        timezone: slot.timezone,
        duration_minutes:
          slot.duration_minutes,
        name: input.name.trim(),
        email: normalisedEmail,
        idempotency_key:
          createIdempotencyKey(
            normalisedEmail,
            slot.starts_at,
            slot.duration_minutes,
          ),
        status: "awaiting_confirmation",
      };

    this.workflow.pending_booking =
      pendingBooking;

    return {
      ok: true,
      requires_confirmation: true,
      pending_booking_id:
        pendingBooking.id,
      summary: {
        name: pendingBooking.name,
        email: pendingBooking.email,
        starts_at:
          pendingBooking.starts_at,
        timezone:
          pendingBooking.timezone,
        duration_minutes:
          pendingBooking.duration_minutes,
      },
      confirmation_instruction:
        'Ask the user to reply with exactly "confirm" to create this booking, or "cancel" to discard it.',
    };
  }

  public recordExplicitDecision(
    userMessage: string,
  ): UserDecisionResult {
    const pending =
      this.workflow.pending_booking;

    if (
      !pending ||
      pending.status !==
        "awaiting_confirmation"
    ) {
      return "ignored";
    }

    const decision =
      normaliseDecision(userMessage);

    if (
      acceptedConfirmations.has(decision)
    ) {
      pending.status = "confirmed";
      return "confirmed";
    }

    if (
      acceptedCancellations.has(decision)
    ) {
      this.workflow.pending_booking =
        null;

      return "cancelled";
    }

    return "ignored";
  }

  public async bookConsultation(
    input: BookConsultationInput,
  ): Promise<ToolResult> {
    const pending =
      this.workflow.pending_booking;

    if (
      !pending ||
      pending.id !==
        input.pending_booking_id
    ) {
      return {
        ok: false,
        code:
          "PENDING_BOOKING_NOT_FOUND",
        message:
          "The referenced pending booking does not exist.",
      };
    }

    if (pending.status === "invalid") {
      return {
        ok: false,
        code: "SLOT_UNAVAILABLE",
        message:
          "This pending booking is no longer valid.",
        retryable: true,
      };
    }

    if (
      pending.status ===
      "awaiting_confirmation"
    ) {
      return {
        ok: false,
        code: "CONFIRMATION_REQUIRED",
        message:
          "The user has not explicitly confirmed this booking.",
      };
    }

    const existingBooking =
      await this.bookingRepository
        .getByIdempotencyKey(
          pending.idempotency_key,
        );

    if (existingBooking) {
      pending.status = "booked";

      this.workflow.last_booking =
        existingBooking;

      return {
        ok: true,
        duplicate_prevented: true,
        booking: existingBooking,
      };
    }

    if (pending.status === "booked") {
      return {
        ok: false,
        code:
          "BOOKING_STATE_INCONSISTENT",
        message:
          "The booking state could not be verified.",
      };
    }

    const occupied =
      await this.calendar.isOccupied(
        pending.starts_at,
      );

    if (occupied) {
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
      duration_minutes:
        pending.duration_minutes,
      name: pending.name,
      email: pending.email,
      status: "confirmed",
      created_at:
        new Date().toISOString(),
    };

    await this.calendar.occupy(
      pending.starts_at,
    );

    await this.bookingRepository.save(
      pending.idempotency_key,
      booking,
    );

    pending.status = "booked";

    this.workflow.last_booking =
      booking;

    return {
      ok: true,
      duplicate_prevented: false,
      booking,
    };
  }

  public async simulateStalePendingSlot():
    Promise<boolean> {
    const pending =
      this.workflow.pending_booking;

    if (!pending) {
      return false;
    }

    await this.calendar.occupy(
      pending.starts_at,
    );

    return true;
  }

  public async retryPendingBooking():
    Promise<ToolResult> {
    const pending =
      this.workflow.pending_booking;

    if (!pending) {
      return {
        ok: false,
        code:
          "PENDING_BOOKING_NOT_FOUND",
        message:
          "No booking is available to retry.",
      };
    }

    return this.bookConsultation({
      pending_booking_id: pending.id,
    });
  }
}