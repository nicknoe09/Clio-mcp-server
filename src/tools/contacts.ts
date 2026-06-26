import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawPostSingle } from "../clio/pagination";

const CONTACT_FIELDS =
  "id,name,first_name,last_name,type,email_addresses,phone_numbers";

// Richer field set used when reading a contact back after creation, so the
// caller sees everything they just set (name, emails, phones, addresses).
const CONTACT_CREATE_READBACK_FIELDS =
  "id,name,first_name,last_name,type,company{id,name}," +
  "email_addresses{name,address,default_email}," +
  "phone_numbers{name,number,default_number}," +
  "addresses{name,street,city,province,postal_code,country}";

export function registerContactTools(server: McpServer): void {
  // get_users — list all firm users with IDs
  server.tool(
    "get_users",
    "List all users (timekeepers/staff) in the firm with their IDs, names, and roles. Use this to look up user_id values for other tools.",
    {},
    async () => {
      try {
        const users = await fetchAllPages<any>("/users", {
          fields: "id,name,email,enabled,subscription_type",
        });

        const formatted = users.map((u: any) => ({
          user_id: u.id,
          name: u.name,
          email: u.email,
          enabled: u.enabled,
          role: u.subscription_type,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: formatted.length, users: formatted }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_contacts",
    "Search contacts by name or email, optionally filter by type (Person/Company). Use matter_id to get contacts associated with a specific matter.",
    {
      search: z.string().optional().describe("Search query (name or email)"),
      matter_id: z.coerce.number().optional().describe("Get contacts associated with a specific matter"),
      type: z
        .enum(["Person", "Company", "all"])
        .optional()
        .default("all")
        .describe("Filter by contact type"),
    },
    async (params) => {
      try {
        if (!params.search && !params.matter_id) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide either 'search' or 'matter_id'" }),
            }],
            isError: true,
          };
        }

        let contacts: any[] = [];

        if (params.matter_id) {
          // Get matter details which include the client contact
          const matterData = await rawGetSingle(`/matters/${params.matter_id}`, {
            fields: "id,display_number,description,client{id,name,first_name,last_name,type,email_addresses,phone_numbers}",
          });
          const client = matterData?.data?.client;
          if (client) {
            contacts = [client];
          }
        } else if (params.search) {
          const queryParams: Record<string, any> = {
            fields: CONTACT_FIELDS,
            query: params.search,
          };
          if (params.type !== "all") {
            queryParams.type = params.type;
          }
          const allContacts = await fetchAllPages<any>("/contacts", queryParams);
          contacts = allContacts.slice(0, 200);
        }

        const formatted = contacts.map((c: any) => ({
          id: c.id,
          name: c.name,
          first_name: c.first_name,
          last_name: c.last_name,
          type: c.type,
          emails: c.email_addresses ?? [],
          phones: c.phone_numbers ?? [],
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, contacts: formatted },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  create_contact — create a client/contact (POST /contacts)
  // ============================================================
  // In Clio a "client" is just a contact. A matter's client_id is a contact
  // ID, so this is the companion to create_matter: make the contact here,
  // then pass its id as create_matter's client_id.
  //
  // Two shapes, selected by `type`:
  //   - Person  → requires first_name and/or last_name (Clio builds `name`).
  //   - Company → requires name.
  // Email / phone / address are optional and only sent when provided. The
  // contact is read back with a rich field set so the caller sees exactly
  // what was created; Clio validation errors are surfaced verbatim.
  server.tool(
    "create_contact",
    "Create a new contact (client) in Clio via POST /contacts. A Clio 'client' is just a contact, and create_matter's client_id is a contact ID — so use this to create the client, then pass the returned id to create_matter. For type='Person' provide first_name and/or last_name; for type='Company' provide name. Email, phone, and address are optional. Reads the contact back after creation and returns it; surfaces Clio validation errors verbatim.",
    {
      type: z
        .enum(["Person", "Company"])
        .describe("REQUIRED. 'Person' for an individual (needs first_name/last_name), 'Company' for an organization (needs name)."),
      first_name: z.string().optional().describe("Person's first name. Required for type='Person' (unless last_name is given)."),
      last_name: z.string().optional().describe("Person's last name. Required for type='Person' (unless first_name is given)."),
      name: z.string().optional().describe("Company name. Required for type='Company'. Ignored for Person (Clio builds the name from first/last)."),
      company_id: z.coerce.number().optional().describe("For a Person: Clio contact ID of the Company they belong to (links the person to an existing company). Find via get_contacts(type='Company')."),
      email: z.string().optional().describe("Email address to attach to the contact."),
      email_label: z
        .string()
        .optional()
        .default("Work")
        .describe("Label for the email (e.g. 'Work', 'Home', 'Other', 'Billing'). Defaults to 'Work'."),
      phone: z.string().optional().describe("Phone number to attach to the contact."),
      phone_label: z
        .string()
        .optional()
        .default("Work")
        .describe("Label for the phone (e.g. 'Work', 'Home', 'Mobile', 'Other'). Defaults to 'Work'."),
      street: z.string().optional().describe("Street address line."),
      city: z.string().optional().describe("Address city."),
      province: z.string().optional().describe("Address state/province."),
      postal_code: z.string().optional().describe("Address ZIP/postal code."),
      country: z.string().optional().describe("Address country."),
      address_label: z
        .string()
        .optional()
        .default("Work")
        .describe("Label for the address (e.g. 'Work', 'Home', 'Billing'). Defaults to 'Work'."),
    },
    async (params) => {
      // Validate the type-specific required fields up front so the caller gets a
      // clear message instead of a raw Clio 422.
      if (params.type === "Person" && !params.first_name && !params.last_name) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: "type='Person' requires first_name and/or last_name." }),
          }],
          isError: true,
        };
      }
      if (params.type === "Company" && !params.name) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: "type='Company' requires name." }),
          }],
          isError: true,
        };
      }

      try {
        const data: Record<string, any> = { type: params.type };
        if (params.type === "Person") {
          if (params.first_name !== undefined) data.first_name = params.first_name;
          if (params.last_name !== undefined) data.last_name = params.last_name;
          if (params.company_id !== undefined) data.company = { id: params.company_id };
        } else {
          data.name = params.name;
        }

        if (params.email !== undefined) {
          data.email_addresses = [
            { name: params.email_label, address: params.email, default_email: true },
          ];
        }
        if (params.phone !== undefined) {
          data.phone_numbers = [
            { name: params.phone_label, number: params.phone, default_number: true },
          ];
        }
        if (
          params.street !== undefined ||
          params.city !== undefined ||
          params.province !== undefined ||
          params.postal_code !== undefined ||
          params.country !== undefined
        ) {
          const address: Record<string, any> = { name: params.address_label };
          if (params.street !== undefined) address.street = params.street;
          if (params.city !== undefined) address.city = params.city;
          if (params.province !== undefined) address.province = params.province;
          if (params.postal_code !== undefined) address.postal_code = params.postal_code;
          if (params.country !== undefined) address.country = params.country;
          data.addresses = [address];
        }

        const result = await rawPostSingle("/contacts", { data });
        const created = result?.data ?? result;

        // Read back with the rich field set so the caller sees the resolved
        // name and nested email/phone/address the POST response may not expand.
        let readback: any = null;
        if (created?.id) {
          try {
            const rb = await rawGetSingle(`/contacts/${created.id}`, { fields: CONTACT_CREATE_READBACK_FIELDS });
            readback = rb?.data ?? rb;
          } catch {
            /* non-fatal: fall back to the POST response below */
          }
        }

        const contact = readback ?? created;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  created: true,
                  contact: {
                    id: contact?.id,
                    name: contact?.name ?? null,
                    first_name: contact?.first_name ?? null,
                    last_name: contact?.last_name ?? null,
                    type: contact?.type ?? null,
                    company: contact?.company ?? null,
                    email_addresses: contact?.email_addresses ?? [],
                    phone_numbers: contact?.phone_numbers ?? [],
                    addresses: contact?.addresses ?? [],
                  },
                  next_step: "Pass this contact's id as create_matter's client_id to open a matter for this client.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        const status = err.response?.status;
        let interpretation: string | undefined;
        if (status === 422) interpretation = "Clio rejected the contact. Most often a required field is missing or malformed (Person needs first_name/last_name, Company needs name), or company_id is not a valid Company contact. See clio_error for the specific field.";
        else if (status === 404) interpretation = "A referenced resource was not found (check company_id).";
        else if (status === 403) interpretation = "Forbidden — the token lacks permission to create contacts.";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status,
                interpretation,
                clio_error: err.response?.data,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
