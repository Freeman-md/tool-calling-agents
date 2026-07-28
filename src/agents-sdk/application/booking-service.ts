import {
  createHash,
  randomUUID,
} from "node:crypto";

import type {
  BookConsultationInput,
  FindSlotsInput,
} from "../domain/schemas";

import type {
  AgentsWorkflowState,
  BookingRepository,
  CalendarGateway,
  ConfirmedBooking,
  ConsultationSlot,
  SupportedDuration,
  ToolResult,
} from "../domain/types";

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

export class AgentsBookingService {
  private readonly workflow:
    AgentsWorkflowState = {
      availability: null,
      last_booking: null,
    };

  public constructor(
    private readonly calendar:
      CalendarGateway,
    private readonly bookingRepository:
      BookingRepository,
  ) {}

  public getWorkflowState():
    AgentsWorkflowState {
    return structuredClone(this.workflow);
  }

  public getModelWorkflowState() {
    return {
      availability:
        this.workflow.availability,
      last_booking:
        this.workflow.last_booking,
    };
  }

  public findSlotById(
    slotId: string,
  ): ConsultationSlot | null {
    const slot =
      this.workflow.availability
        ?.slots.find(
          (candidate) =>
            candidate.id === slotId,
        );

    return slot
      ? structuredClone(slot)
      : null;
  }

  public async findAvailableSlots(
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

  public async createBooking(
    input: BookConsultationInput,
  ): Promise<ToolResult> {
    const availability =
      this.workflow.availability;

    if (!availability) {
      return {
        ok: false,
        code: "AVAILABILITY_REQUIRED",
        message:
          "Availability must be checked before creating a booking.",
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

    const normalisedEmail = input.email
      .trim()
      .toLowerCase();

    const idempotencyKey =
      createIdempotencyKey(
        normalisedEmail,
        slot.starts_at,
        slot.duration_minutes,
      );

    const existingBooking =
      await this.bookingRepository
        .getByIdempotencyKey(
          idempotencyKey,
        );

    if (existingBooking) {
      this.workflow.last_booking =
        existingBooking;

      return {
        ok: true,
        duplicate_prevented: true,
        booking: existingBooking,
      };
    }

    /*
     * Approval happened before this function,
     * but availability can still change during
     * that approval window.
     */
    const occupied =
      await this.calendar.isOccupied(
        slot.starts_at,
      );

    if (occupied) {
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
      duration_minutes:
        slot.duration_minutes,
      name: input.name.trim(),
      email: normalisedEmail,
      status: "confirmed",
      created_at:
        new Date().toISOString(),
    };

    await this.calendar.occupy(
      slot.starts_at,
    );

    await this.bookingRepository.save(
      idempotencyKey,
      booking,
    );

    this.workflow.last_booking =
      booking;

    return {
      ok: true,
      duplicate_prevented: false,
      booking,
    };
  }

  public async simulateStaleSlot(
    slotId: string,
  ): Promise<boolean> {
    const slot =
      this.findSlotById(slotId);

    if (!slot) {
      return false;
    }

    await this.calendar.occupy(
      slot.starts_at,
    );

    return true;
  }

  public async retryLastBooking():
    Promise<ToolResult> {
    const booking =
      this.workflow.last_booking;

    if (!booking) {
      return {
        ok: false,
        code: "BOOKING_NOT_FOUND",
        message:
          "No successful booking is available to retry.",
      };
    }

    const idempotencyKey =
      createIdempotencyKey(
        booking.email,
        booking.starts_at,
        booking.duration_minutes,
      );

    const existingBooking =
      await this.bookingRepository
        .getByIdempotencyKey(
          idempotencyKey,
        );

    if (!existingBooking) {
      return {
        ok: false,
        code:
          "BOOKING_STATE_INCONSISTENT",
        message:
          "The previous booking could not be verified.",
      };
    }

    this.workflow.last_booking =
      existingBooking;

    return {
      ok: true,
      duplicate_prevented: true,
      booking: existingBooking,
    };
  }
}