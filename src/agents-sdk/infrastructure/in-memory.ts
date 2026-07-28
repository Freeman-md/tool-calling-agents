import type {
  BookingRepository,
  CalendarGateway,
  ConfirmedBooking,
} from "../domain/types";

const DEFAULT_START_TIMES = [
  "2026-07-28T10:00:00+01:00",
  "2026-07-28T14:30:00+01:00",
  "2026-07-29T11:00:00+01:00",
] as const;

export class InMemoryCalendarGateway
  implements CalendarGateway
{
  private readonly occupiedStartTimes =
    new Set<string>();

  public constructor(
    private readonly startTimes:
      readonly string[] = DEFAULT_START_TIMES,
  ) {}

  public async listStartTimes(): Promise<
    readonly string[]
  > {
    return [...this.startTimes];
  }

  public async isOccupied(
    startsAt: string,
  ): Promise<boolean> {
    return this.occupiedStartTimes.has(
      startsAt,
    );
  }

  public async occupy(
    startsAt: string,
  ): Promise<void> {
    this.occupiedStartTimes.add(startsAt);
  }
}

export class InMemoryBookingRepository
  implements BookingRepository
{
  private readonly bookings =
    new Map<string, ConfirmedBooking>();

  public async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ConfirmedBooking | null> {
    return (
      this.bookings.get(idempotencyKey) ??
      null
    );
  }

  public async save(
    idempotencyKey: string,
    booking: ConfirmedBooking,
  ): Promise<void> {
    this.bookings.set(
      idempotencyKey,
      booking,
    );
  }
}