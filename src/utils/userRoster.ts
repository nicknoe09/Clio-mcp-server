// Clio user roster — used by /review to build URLs and look up users by name
export interface ClioUser {
  id: number;
  name: string;
  role: "Attorney" | "NonAttorney";
  active: boolean;
}

export const CLIO_USERS: ClioUser[] = [
  // --- ACTIVE ---
  { id: 344117381, name: "Paul Romano",         role: "Attorney",    active: true },
  { id: 344119597, name: "Rachel Trevino",       role: "NonAttorney", active: true },
  { id: 344134017, name: "Kenny Sumner",         role: "Attorney",    active: true },
  { id: 348755029, name: "Nicholas Noe",         role: "Attorney",    active: true },
  { id: 357646654, name: "Lauren Amy Kutac",     role: "NonAttorney", active: true },
  { id: 358108805, name: "Anna Lozano",          role: "NonAttorney", active: true },
  { id: 358528744, name: "Angela Alanis",        role: "NonAttorney", active: true },
  { id: 358550509, name: "Kaz Gonzalez",         role: "NonAttorney", active: true },
  { id: 358992379, name: "Grace Noe",            role: "NonAttorney", active: true },
  { id: 359138569, name: "Christopher Winiecki", role: "Attorney",    active: true },
  { id: 359380639, name: "Nicholas Fernelius",   role: "Attorney",    active: true },
  { id: 359576660, name: "May Huynh",            role: "Attorney",    active: true },
  { id: 359650460, name: "Alejandra Iriarte",    role: "NonAttorney", active: true },
  { id: 359711375, name: "Tzipora Simmons",      role: "Attorney",    active: true },
  { id: 359865560, name: "Courteney Daniel",     role: "Attorney",    active: true },
  { id: 360049685, name: "Gus Vlahadamis",       role: "Attorney",    active: true },
  { id: 360091325, name: "Jonathan Barbee",      role: "Attorney",    active: true },
];

export function findUserByName(name: string): ClioUser | undefined {
  const lower = name.toLowerCase();
  return CLIO_USERS.find(u => u.name.toLowerCase().includes(lower));
}

export function findUserById(id: number): ClioUser | undefined {
  return CLIO_USERS.find(u => u.id === id);
}

export function getActiveUsers(): ClioUser[] {
  return CLIO_USERS.filter(u => u.active);
}
