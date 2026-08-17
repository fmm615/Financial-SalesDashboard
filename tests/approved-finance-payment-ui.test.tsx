import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cApprovedFinancePosting } from "@/features/b2c/b2c-approved-finance-posting";

afterEach(() => vi.unstubAllGlobals());

describe("approved Finance payment posting UI", () => {
  it("posts the already approved Finance rows and explains the safe result", async () => {
    const onPosted = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { postedPayments: 2, alreadyPostedPayments: 1, skippedRows: 3 } }),
    }));

    render(<B2cApprovedFinancePosting onPosted={onPosted} />);

    expect(screen.getByText(/does not alter the workbook/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Post approved Finance payments" }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/admin/b2c/finance-ledger-posts", { method: "POST" });
    expect(screen.getByText("2 Finance payments added to the B2C ledger.")).toBeInTheDocument();
    expect(screen.getByText("1 was already in the ledger. 3 were kept out because their source was not eligible to post.")).toBeInTheDocument();
  });
});
