export const SUPPORTED_DURATIONS = [
  30,
  45,
  60,
  90,
] as const;

export type SupportedDuration =
  (typeof SUPPORTED_DURATIONS)[number];

export type ConsultationSlot = {
  id: string;
  starts_at: string;
  timezone: string;
  duration_minutes: SupportedDuration;
};

export type AvailabilityState = {
  checked_at: string;
  timezone: string;
  duration_minutes: SupportedDuration;
  slots: ConsultationSlot[];
};

export type ConfirmedBooking = {
  booking_id: string;
  slot_id: string;
  starts_at: string;
  timezone: string;
  duration_minutes: SupportedDuration;
  name: string;
  email: string;
  status: "confirmed";
  created_at: string;
};

export type AgentsWorkflowState = {
  availability: AvailabilityState | null;
  last_booking: ConfirmedBooking | null;
};

export type ToolSuccess = {
  ok: true;
  [key: string]: unknown;
};

export type ToolFailure = {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
};

export type ToolResult =
  | ToolSuccess
  | ToolFailure;

export interface CalendarGateway {
  listStartTimes(): Promise<readonly string[]>;

  isOccupied(
    startsAt: string,
  ): Promise<boolean>;

  occupy(
    startsAt: string,
  ): Promise<void>;
}

export interface BookingRepository {
  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ConfirmedBooking | null>;

  save(
    idempotencyKey: string,
    booking: ConfirmedBooking,
  ): Promise<void>;
}