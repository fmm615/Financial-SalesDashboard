import type { DatabaseClient } from "@/lib/supabase/server";
import type { OperationalProgressInput } from "@/lib/validation/target-contracts";
import type { OperationalTargetForProgress, RecordedOperationalProgress, TargetRepository } from "@/server/services/target-management";

export class SupabaseTargetRepository implements TargetRepository {
  constructor(private readonly client: DatabaseClient) {}

  async findOperationalTarget(id: string): Promise<OperationalTargetForProgress | null> {
    const { data, error } = await this.client.from("operational_targets").select("id,status").eq("id", id).maybeSingle();
    if (error) throw new Error("Could not load operational target.");
    return data;
  }

  async createOperationalProgress(input: OperationalProgressInput): Promise<RecordedOperationalProgress> {
    const { data, error } = await this.client.from("operational_target_progress_updates")
      .insert({ target_id: input.targetId, actual_value: input.actualValue, effective_on: input.effectiveOn, evidence_note: input.evidenceNote })
      .select("id,target_id,actual_value,effective_on,evidence_note")
      .single();
    if (error) throw new Error("Could not save operational target progress.");
    return { id: data.id, targetId: data.target_id, actualValue: data.actual_value, effectiveOn: data.effective_on, evidenceNote: data.evidence_note };
  }
}

