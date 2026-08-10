import type { DatabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";
import type {
  ReviewQueueDetailRecord,
  ReviewQueueFlagRecord,
  ReviewQueueNoteRecord,
  ReviewQueueRepository,
  ReviewQueueResolutionRecord,
} from "@/server/services/review-queue";

type ReviewFlagRow = Pick<Database["public"]["Tables"]["review_flags"]["Row"], "id" | "source_area" | "source_record_id" | "flag_type" | "status" | "priority" | "reason" | "assigned_to" | "created_at" | "resolved_at">;
type ReviewResolutionRow = Pick<Database["public"]["Tables"]["review_flag_resolutions"]["Row"], "resolution_status" | "resolution_note" | "created_by" | "created_at">;
type ReviewNoteRow = Pick<Database["public"]["Tables"]["review_notes"]["Row"], "id" | "note" | "created_by" | "created_at">;

function toFlagRecord(flag: ReviewFlagRow): ReviewQueueFlagRecord {
  return {
    id: flag.id,
    sourceArea: flag.source_area,
    sourceRecordId: flag.source_record_id,
    flagType: flag.flag_type,
    status: flag.status,
    priority: flag.priority,
    reason: flag.reason,
    assignedTo: flag.assigned_to,
    createdAt: flag.created_at,
    resolvedAt: flag.resolved_at,
  };
}

function toResolutionRecord(resolution: ReviewResolutionRow): ReviewQueueResolutionRecord {
  return {
    resolutionStatus: resolution.resolution_status,
    resolutionNote: resolution.resolution_note,
    createdBy: resolution.created_by,
    createdAt: resolution.created_at,
  };
}

function toNoteRecord(note: ReviewNoteRow): ReviewQueueNoteRecord {
  return { id: note.id, note: note.note, createdBy: note.created_by, createdAt: note.created_at };
}

/** RLS-backed read access for review metadata only; source financial values stay in their domain workflows. */
export class SupabaseReviewQueueRepository implements ReviewQueueRepository {
  constructor(private readonly client: DatabaseClient) {}

  async listFlags(): Promise<ReviewQueueFlagRecord[]> {
    const { data, error } = await this.client.from("review_flags")
      .select("id,source_area,source_record_id,flag_type,status,priority,reason,assigned_to,created_at,resolved_at")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) throw new Error("Could not load review flags.");
    return (data ?? []).map(toFlagRecord);
  }

  async getFlagDetail(flagId: string): Promise<ReviewQueueDetailRecord | null> {
    const flagResult = await this.client.from("review_flags")
      .select("id,source_area,source_record_id,flag_type,status,priority,reason,assigned_to,created_at,resolved_at")
      .eq("id", flagId)
      .maybeSingle();
    if (flagResult.error) throw new Error("Could not load the review flag.");
    if (!flagResult.data) return null;

    const [resolutionResult, noteResult] = await Promise.all([
      this.client.from("review_flag_resolutions")
        .select("resolution_status,resolution_note,created_by,created_at")
        .eq("flag_id", flagId)
        .order("created_at", { ascending: true }),
      this.client.from("review_notes")
        .select("id,note,created_by,created_at")
        .eq("flag_id", flagId)
        .order("created_at", { ascending: true }),
    ]);
    if (resolutionResult.error || noteResult.error) throw new Error("Could not load review history.");

    return {
      flag: toFlagRecord(flagResult.data),
      resolutions: (resolutionResult.data ?? []).map(toResolutionRecord),
      notes: (noteResult.data ?? []).map(toNoteRecord),
    };
  }
}
