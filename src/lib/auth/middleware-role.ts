import type { AppRole } from "@/lib/auth/role-context";

/**
 * Reads only the role value that authenticated middleware forwards internally.
 * Callers must still verify the session user and compare the result explicitly.
 */
export function requireMiddlewareRole(request: Pick<Request, "headers">): AppRole | null {
  const role = request.headers.get("x-playbook-role");
  if (role === "admin") return "admin";
  if (role === "viewer") return "viewer";
  return null;
}
