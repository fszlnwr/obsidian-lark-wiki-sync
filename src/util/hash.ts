import { createHash } from "crypto";

export function hashString(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}
