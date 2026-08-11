import {
  operationalProgressSchema,
  type OperationalProgressInput,
} from "@/lib/validation/target-contracts";

export type OperationalTargetForProgress = {
  id: string;
  status: "draft" | "active" | "archived";
};

export type RecordedOperationalProgress = OperationalProgressInput & { id: string };

export interface TargetRepository {
  findOperationalTarget(id: string): Promise<OperationalTargetForProgress | null>;
  createOperationalProgress(input: OperationalProgressInput): Promise<RecordedOperationalProgress>;
}

/** Financial actuals never use this path; only an active operational target can receive a manual update. */
export async function recordOperationalProgress(
  input: unknown,
  repository: TargetRepository,
): Promise<RecordedOperationalProgress> {
  const value = operationalProgressSchema.parse(input);
  const target = await repository.findOperationalTarget(value.targetId);
  if (!target || target.status !== "active") {
    throw new Error("Operational target not found or inactive.");
  }
  return repository.createOperationalProgress(value);
}

