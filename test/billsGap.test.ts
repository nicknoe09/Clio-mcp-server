import { beforeEach, describe, expect, it, vi } from "vitest";

const paginationMocks = vi.hoisted(() => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("../src/clio/pagination", () => ({
  buildQueryString: vi.fn(() => ""),
  fetchAllPages: paginationMocks.fetchAllPages,
  rawGetSingle: vi.fn(),
  rawGetBinarySingle: vi.fn(),
  rawPatchSingle: vi.fn(),
  rawPostSingle: vi.fn(),
}));

import { formatBillableMatter, registerBillsGapTools } from "../src/tools/billsGap";

type ToolHandler = (params: any) => Promise<any>;

function getBillThemesHandler(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  };
  registerBillsGapTools(server as any);
  const handler = handlers.get("get_bill_themes");
  if (!handler) throw new Error("get_bill_themes was not registered");
  return handler;
}

function resultPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("formatBillableMatter", () => {
  it("maps currency_code to currency and surfaces WIP fields", () => {
    const m = formatBillableMatter({
      id: 5,
      display_number: "00012-Smith",
      client: { id: 9, name: "Smith" },
      unbilled_hours: 3.5,
      unbilled_amount: 1225,
      amount_in_trust: 500,
      currency_code: "USD",
    });
    expect(m).toEqual({
      id: 5,
      display_number: "00012-Smith",
      client: { id: 9, name: "Smith" },
      unbilled_hours: 3.5,
      unbilled_amount: 1225,
      amount_in_trust: 500,
      currency: "USD",
    });
  });

  it("tolerates an empty object", () => {
    expect(formatBillableMatter({}).id).toBeUndefined();
  });
});

describe("get_bill_themes", () => {
  beforeEach(() => {
    paginationMocks.fetchAllPages.mockReset();
  });

  it("omits config from the default list response", async () => {
    paginationMocks.fetchAllPages.mockResolvedValue([
      { id: 7, name: "Standard", default: true, config: { enormous: "secret" } },
    ]);

    const result = await getBillThemesHandler()({ limit: 50, include_config: false });
    const payload = resultPayload(result);

    expect(payload.bill_themes).toEqual([
      { id: 7, name: "Standard", default: true },
    ]);
    expect(payload.bill_themes[0]).not.toHaveProperty("config");
  });

  it("returns config for one explicitly requested theme", async () => {
    const config = { logo: "firm-logo", columns: ["date", "description"] };
    paginationMocks.fetchAllPages.mockResolvedValue([
      { id: 7, name: "Standard", default: true, config },
    ]);

    const result = await getBillThemesHandler()({
      limit: 50,
      theme_id: 7,
      include_config: true,
    });

    expect(resultPayload(result).bill_themes[0].config).toEqual(config);
  });

  it("rejects include_config without a theme_id", async () => {
    const result = await getBillThemesHandler()({
      limit: 50,
      include_config: true,
    });

    expect(result.isError).toBe(true);
    expect(resultPayload(result).message).toContain("include_config requires theme_id");
    expect(paginationMocks.fetchAllPages).not.toHaveBeenCalled();
  });

  it("sends theme_id to Clio as the ids[] query parameter", async () => {
    paginationMocks.fetchAllPages.mockResolvedValue([]);

    await getBillThemesHandler()({
      limit: 25,
      theme_id: 42,
      include_config: true,
    });

    expect(paginationMocks.fetchAllPages).toHaveBeenCalledWith(
      "/bill_themes",
      expect.objectContaining({
        "ids[]": 42,
        fields: expect.stringContaining("config"),
      }),
      25,
    );
  });
});
