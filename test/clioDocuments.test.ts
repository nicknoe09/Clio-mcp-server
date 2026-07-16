import { describe, it, expect } from "vitest";
import { resolveParent, formatDocument } from "../src/tools/clioDocuments";

describe("resolveParent", () => {
  it("maps folder_id to a Folder parent", () => {
    expect(resolveParent({ folder_id: 12 })).toEqual({ id: 12, type: "Folder" });
  });

  it("maps matter_id to a Matter parent", () => {
    expect(resolveParent({ matter_id: 34 })).toEqual({ id: 34, type: "Matter" });
  });

  it("maps contact_id to a Contact parent", () => {
    expect(resolveParent({ contact_id: 56 })).toEqual({ id: 56, type: "Contact" });
  });

  it("rejects when no destination is given", () => {
    expect(resolveParent({})).toHaveProperty("error");
  });

  it("rejects when more than one destination is given", () => {
    expect(resolveParent({ folder_id: 1, matter_id: 2 })).toHaveProperty("error");
    expect(resolveParent({ folder_id: 1, matter_id: 2, contact_id: 3 })).toHaveProperty("error");
  });

  it("accepts id 0 as a provided (if nonsensical) value rather than treating it as absent", () => {
    expect(resolveParent({ folder_id: 0 })).toEqual({ id: 0, type: "Folder" });
  });
});

describe("formatDocument", () => {
  it("renames Clio's parent/document_category/latest_document_version keys", () => {
    const formatted = formatDocument({
      id: 7,
      name: "Engagement Letter.pdf",
      filename: "engagement-letter.pdf",
      size: 1024,
      content_type: "application/pdf",
      locked: false,
      parent: { id: 3, name: "Correspondence" },
      matter: { id: 9, display_number: "00012-Smith" },
      document_category: { id: 4, name: "Letters" },
      latest_document_version: { id: 88, version_number: 2, fully_uploaded: true },
    });
    expect(formatted.folder).toEqual({ id: 3, name: "Correspondence" });
    expect(formatted.category).toEqual({ id: 4, name: "Letters" });
    expect(formatted.latest_version).toEqual({ id: 88, version_number: 2, fully_uploaded: true });
    expect(formatted.matter).toEqual({ id: 9, display_number: "00012-Smith" });
  });

  it("tolerates an empty object (failed/partial API responses)", () => {
    const formatted = formatDocument({});
    expect(formatted.id).toBeUndefined();
    expect(formatted.folder).toBeUndefined();
  });
});
