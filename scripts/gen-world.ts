/* Writes the simulated world: samples/world.json (the known truth) and
   samples/attendees-large.csv (the messy upload a registration system would export).

     node scripts/gen-world.ts [outDir]

   Deterministic: a fixed seed and no clock, so two runs write identical bytes.
   Every company, person and domain is fictional. Every true domain ends in
   `.example`, a name reserved so it can never resolve. The placeholder and webmail
   domains below appear only as text inside the file; nothing ever connects to them. */

import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import Papa from "papaparse";
import { companyKey } from "../src/shared/ingest.ts";
import type { HardCase, MessStat, World, WorldCompany, WorldPerson, WorldRow, WTier } from "../src/shared/world.ts";

export const SEED = 20261108;
export const TOTAL_ROWS = 1650;
export const COMPANIES = 420;
export const PLACEHOLDER_DOMAINS = ["test.com", "company.com", "none.com", "asdf.com"];
export const WEBMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "proton.me"];
const EMAIL_TYPO_DOMAINS = ["gmial.com", "gmai.com", "gnail.com", "hotmial.com", "yahooo.com", "outlok.com", "gmail.con", "yahoo.cmo"];
const AGENCY_DOMAIN = "pavilionevents.example";

/* ------------------------------------------------------------------ rng */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- name pools */

type Culture = "es" | "pt" | "fr" | "de" | "nordic" | "pl" | "tr" | "ar" | "in" | "asia" | "af" | "anglo" | "it";
const NAMES: Record<Culture, { first: string[]; last: string[] }> = {
  es: {
    first: ["José", "María", "Carlos", "Lucía", "Andrés", "Valentina", "Sebastián", "Camila", "Joaquín", "Ximena", "Rafael", "Inés", "Álvaro", "Beatriz", "Héctor", "Marisol", "Ángel", "Yaritza", "Rosalía", "Nicolás", "Mónica", "Ramón", "Dayana", "Esteban", "Natalia", "Gabriel", "Pilar", "Julián", "Altagracia", "Fabiola", "Rubén", "Soledad", "Emilio", "Estefanía", "Wilfredo"],
    last: ["García", "Núñez", "Peña", "Fernández", "Rodríguez", "Martínez", "Gómez", "Álvarez", "Pérez", "Hernández", "Jiménez", "Mejía", "Santana", "Cabrera", "Domínguez", "Castillo", "Vargas", "Reyes", "Báez", "Guzmán", "Sosa", "Ramírez", "Acosta", "Montero", "Paredes", "Bonilla", "Echeverría", "Zapata", "Villanueva", "Calderón", "Quiñones", "Batista", "Lantigua", "Restrepo", "Ibáñez"],
  },
  pt: {
    first: ["João", "Fernanda", "Thiago", "Beatriz", "Gonçalo", "Letícia", "Rodrigo", "Mariana", "Caio", "Larissa", "Inês", "Tiago", "Bruna", "Vítor", "Luana", "Rúben", "Joana", "Matheus", "Sílvia", "Ícaro"],
    last: ["Souza", "Oliveira", "Gonçalves", "Barbosa", "Cardoso", "Araújo", "Teixeira", "Moreira", "Nascimento", "Carvalho", "Ribeiro", "Machado", "Figueiredo", "Pinheiro", "Albuquerque", "Siqueira", "Viana", "Lacerda", "Tavares", "Furtado"],
  },
  fr: {
    first: ["Étienne", "Amélie", "Clément", "Océane", "Mathieu", "Élodie", "Baptiste", "Camille", "Hélène", "Thibault", "Solène", "Rémi", "Margaux", "Gaël", "Chloé", "Aurélien", "Noémie", "Loïc", "Mélanie", "Yann"],
    last: ["Lefèvre", "Moreau", "Beaumont", "Gauthier", "Fournier", "Rousseau", "Lambert", "Dupuis", "Girard", "Mercier", "Bélanger", "Delacroix", "Marchand", "Pelletier", "Vasseur", "Chevalier", "Aubert", "Lacombe", "Tessier", "Brunet"],
  },
  de: {
    first: ["Jürgen", "Lena", "Matthias", "Anja", "Björn", "Katharina", "Dieter", "Sabine", "Florian", "Greta", "Jörg", "Svenja", "Tobias", "Ute", "Lukas", "Franziska", "Konrad", "Heike", "Moritz", "Nele"],
    last: ["Müller", "Schäfer", "Köhler", "Weiß", "Hoffmann", "Bauer", "Kröger", "Zimmermann", "Fuchs", "Brandt", "Lüdke", "Hartmann", "Engel", "Böhm", "Sommer", "Vogel", "Neumann", "Krämer", "Ebert", "Günther"],
  },
  nordic: {
    first: ["Åsa", "Søren", "Linnéa", "Mikkel", "Sigrid", "Henrik", "Freya", "Anders", "Ingrid", "Bjørn", "Thea", "Magnus", "Astrid", "Kasper", "Maja", "Olle", "Signe", "Rasmus", "Ylva", "Torbjörn"],
    last: ["Lindqvist", "Søndergaard", "Håkansson", "Nyström", "Halvorsen", "Eriksen", "Dahl", "Ødegård", "Holmgren", "Åberg", "Bergström", "Kjær", "Sørensen", "Ekström", "Strand", "Lundgren", "Vik", "Æbelø", "Rosenqvist", "Falk"],
  },
  pl: {
    first: ["Łukasz", "Zofia", "Wojciech", "Agnieszka", "Jakub", "Małgorzata", "Dominik", "Kateřina", "Tomáš", "Žaneta", "Paweł", "Ewelina", "Michał", "Dagmar", "Radek", "Bożena", "Krzysztof", "Jana", "Marek", "Ľubica"],
    last: ["Kowalczyk", "Wiśniewski", "Dvořák", "Nowak", "Szymański", "Černý", "Wójcik", "Lewandowska", "Procházka", "Zielińska", "Kamiński", "Horák", "Mazur", "Svoboda", "Piotrowski", "Krejčí", "Dąbrowska", "Němec", "Grabowski", "Řezníček"],
  },
  tr: {
    first: ["Çağla", "Emre", "Zeynep", "Mehmet", "Gökhan", "Elif", "Burak", "Şule", "Ahmet", "İpek", "Selin", "Onur", "Gül", "Cem", "Derya", "Barış", "Özlem", "Tolga", "Büşra", "Kerem"],
    last: ["Çelik", "Yıldız", "Demir", "Öztürk", "Kaya", "Şahin", "Aydın", "Arslan", "Doğan", "Koç", "Yılmaz", "Güneş", "Polat", "Erdoğan", "Aksoy", "Tunç", "Özdemir", "Kılıç", "Bulut", "Sarı"],
  },
  ar: {
    first: ["Layla", "Karim", "Yasmin", "Tariq", "Noor", "Hassan", "Samira", "Khaled", "Rania", "Walid", "Dina", "Faisal", "Hala", "Ziad", "Mariam", "Nabil", "Salma", "Rashid", "Amal", "Bassam"],
    last: ["Nasser", "Al-Farsi", "Mansour", "Khalil", "Saleh", "Darwish", "Barakat", "Abboud", "Al-Hashimi", "Haddadin", "Suleiman", "Qureshi", "Jaber", "Ghanem", "Zayed", "Shaheen", "Habib", "Al-Mansoori", "Awad", "Rizk"],
  },
  in: {
    first: ["Aarav", "Priyanka", "Rohan", "Ananya", "Vikram", "Meera", "Siddharth", "Kavya", "Arjun", "Divya", "Nikhil", "Pooja", "Rahul", "Sneha", "Aditya", "Isha", "Karthik", "Lakshmi", "Varun", "Tanvi"],
    last: ["Iyer", "Banerjee", "Kulkarni", "Venkataraman", "Chatterjee", "Reddy", "Mehta", "Joshi", "Nair", "Desai", "Bhatt", "Menon", "Sengupta", "Pillai", "Kapoor", "Rao", "Gokhale", "Naidu", "Trivedi", "Sethi"],
  },
  asia: {
    first: ["Haruto", "Yuki", "Mei", "Jun", "Min-jun", "Seo-yeon", "Wei", "Hana", "Kenji", "Ji-woo", "Aiko", "Takumi", "Xiu", "Do-yun", "Sakura", "Hiro", "Lan", "Ryo", "Eun-ji", "Chen"],
    last: ["Tanaka", "Watanabe", "Kim", "Park", "Zhang", "Wang", "Nakamura", "Yamamoto", "Choi", "Lin", "Sato", "Kobayashi", "Jeong", "Huang", "Ito", "Kang", "Liu", "Matsumoto", "Yoon", "Zhou"],
  },
  af: {
    first: ["Chinedu", "Adaeze", "Kwame", "Ama", "Tunde", "Folake", "Kofi", "Ngozi", "Emeka", "Abena", "Seun", "Efua", "Obinna", "Yaa", "Femi", "Nneka", "Kojo", "Ife", "Chidi", "Akosua"],
    last: ["Okafor", "Mensah", "Adeyemi", "Boateng", "Eze", "Nwosu", "Owusu", "Balogun", "Danso", "Okoye", "Appiah", "Adebayo", "Asante", "Obi", "Ogunleye", "Agyeman", "Ibekwe", "Quartey", "Onyeama", "Fashola"],
  },
  anglo: {
    first: ["James", "Olivia", "Connor", "Hannah", "Declan", "Grace", "Marcus", "Priscilla", "Tyler", "Eleanor", "Owen", "Imogen", "Callum", "Fiona", "Dylan", "Rosalind", "Graham", "Tessa", "Elliot", "Maeve"],
    last: ["Whitmore", "Hargreaves", "Callahan", "Pemberton", "Sullivan", "Fitzgerald", "Brennan", "Aldridge", "Thornton", "Kensington", "Prescott", "Garrity", "Holloway", "Winslow", "Ashworth", "Bellamy", "Cavanagh", "Dunleavy", "Ellsworth", "Tremaine"],
  },
  it: {
    first: ["Giulia", "Matteo", "Chiara", "Lorenzo", "Federica", "Davide", "Valeria", "Alessio", "Serena", "Gianluca", "Elena", "Pietro", "Silvia", "Raffaele", "Ilaria", "Massimo", "Cristina", "Fabio", "Paola", "Tullio"],
    last: ["Bianchi", "Esposito", "Moretti", "Greco", "Ferrante", "Marchetti", "Colombo", "Barbieri", "Fontana", "Caruso", "Santoro", "Rinaldi", "Gallo", "Bruno", "Conti", "Orlando", "Vitale", "Leone", "Pagano", "Sorrentino"],
  },
};
/** Native-script spellings used for a few attendees, so the file carries non-Latin text. */
const NATIVE: [string, string, string, string][] = [["Yuki", "Tanaka", "悠希", "田中"], ["Mei", "Lin", "美", "林"], ["Seo-yeon", "Kim", "서연", "김"], ["Wei", "Zhang", "伟", "张"], ["Haruto", "Sato", "陽翔", "佐藤"], ["Min-jun", "Park", "민준", "박"]];

const COUNTRIES: { name: string; code: string; local: string; culture: Culture; w: number }[] = [
  { name: "Dominican Republic", code: "DO", local: "República Dominicana", culture: "es", w: 7 },
  { name: "Spain", code: "ES", local: "España", culture: "es", w: 11 },
  { name: "Mexico", code: "MX", local: "México", culture: "es", w: 7 },
  { name: "Colombia", code: "CO", local: "Colombia", culture: "es", w: 4 },
  { name: "Argentina", code: "AR", local: "Argentina", culture: "es", w: 3 },
  { name: "Brazil", code: "BR", local: "Brasil", culture: "pt", w: 6 },
  { name: "Portugal", code: "PT", local: "Portugal", culture: "pt", w: 4 },
  { name: "France", code: "FR", local: "France", culture: "fr", w: 8 },
  { name: "Germany", code: "DE", local: "Deutschland", culture: "de", w: 9 },
  { name: "Sweden", code: "SE", local: "Sverige", culture: "nordic", w: 3 },
  { name: "Denmark", code: "DK", local: "Danmark", culture: "nordic", w: 2 },
  { name: "Poland", code: "PL", local: "Polska", culture: "pl", w: 4 },
  { name: "Czechia", code: "CZ", local: "Česko", culture: "pl", w: 2 },
  { name: "Turkey", code: "TR", local: "Türkiye", culture: "tr", w: 4 },
  { name: "United Arab Emirates", code: "AE", local: "الإمارات", culture: "ar", w: 3 },
  { name: "India", code: "IN", local: "India", culture: "in", w: 5 },
  { name: "Japan", code: "JP", local: "日本", culture: "asia", w: 3 },
  { name: "South Korea", code: "KR", local: "대한민국", culture: "asia", w: 2 },
  { name: "Nigeria", code: "NG", local: "Nigeria", culture: "af", w: 3 },
  { name: "Ghana", code: "GH", local: "Ghana", culture: "af", w: 1 },
  { name: "United Kingdom", code: "GB", local: "UK", culture: "anglo", w: 8 },
  { name: "United States", code: "US", local: "USA", culture: "anglo", w: 8 },
  { name: "Ireland", code: "IE", local: "Éire", culture: "anglo", w: 2 },
  { name: "Italy", code: "IT", local: "Italia", culture: "it", w: 5 },
];

/* ------------------------------------------------------------------- titles */

type T = [string, WTier];
const T1: T[] = ["Chief Revenue Officer", "CRO", "VP Sales", "VP of Sales", "Vice President, Sales", "Vice President of Revenue", "VP Revenue Operations", "Head of Revenue Operations", "Head of Sales", "Head of Growth", "SVP Sales", "Chief Commercial Officer", "Chief Executive Officer", "CEO", "Founder & CEO", "Co-Founder", "Founder", "Managing Director", "Owner", "President", "General Manager", "Chief Marketing Officer", "Chief Operating Officer", "Chief Growth Officer", "Managing Partner", "Chief Financial Officer", "VP Business Development", "VP Marketing", "VP Customer Success", "Chief Customer Officer"].map((t): T => [t, 1]);
const T2_BASE = ["Account Executive", "Sales Development Representative", "Business Development Representative", "Sales Manager", "Regional Sales Manager", "Director of Sales", "Sales Director", "Marketing Manager", "Director of Marketing", "Head of Marketing", "Partnerships Manager", "Customer Success Manager", "Solutions Engineer", "Sales Engineer", "Revenue Operations Manager", "Sales Operations Analyst", "Demand Generation Manager", "Key Account Manager", "Channel Manager", "Business Development Manager", "Growth Marketing Manager", "Sales Enablement Manager", "Field Marketing Manager", "Account Manager", "Inside Sales Representative", "Commercial Director", "Regional Director", "Partnership Lead", "Brand Manager", "Product Marketing Manager"];
const T3_BASE = ["Software Engineer", "DevOps Engineer", "QA Engineer", "Data Engineer", "Data Scientist", "Financial Analyst", "Accountant", "Controller", "HR Manager", "Talent Acquisition Specialist", "Recruiter", "Office Manager", "Executive Assistant", "Administrative Assistant", "Legal Counsel", "Paralegal", "Procurement Manager", "Supply Chain Analyst", "Warehouse Supervisor", "Operations Manager", "Logistics Coordinator", "IT Administrator", "Security Analyst", "Product Designer", "Graphic Designer", "UX Researcher", "Customer Support Agent", "Support Engineer", "Compliance Officer", "Project Manager", "Production Planner", "Quality Manager", "Facilities Manager", "Intern", "Marketing Intern", "Receptionist", "Payroll Specialist", "Research Scientist", "Mechanical Engineer", "Civil Engineer"];
/** Inflated titles. The tier is the generator author's judgment of the real job, stated here. */
const INFLATED: T[] = [["Chief Happiness Officer", 3], ["Growth Ninja", 2], ["Sales Rockstar", 2], ["VP of Everything", 2], ["Global Head of Strategic Synergies", 2], ["Chief Evangelist", 2], ["Revenue Wizard", 2], ["Dream Weaver & Head of Culture", 3], ["Director of First Impressions", 3], ["Founder & Chief Everything Officer", 1], ["Customer Delight Hero", 2], ["Chief Vibes Officer", 3], ["Principal Disruptor", 2]];
const AMBIGUOUS: T[] = [["Partner", 1], ["Associate", 3], ["Consultant", 3], ["Manager", 2], ["Executive", 2], ["Lead", 2], ["Specialist", 3], ["Officer", 3], ["Advisor", 2], ["Analyst", 3], ["Coordinator", 3], ["Representative", 2], ["Principal", 2], ["Director", 2]];
const LOCAL: Partial<Record<Culture, T[]>> = {
  es: [["Director General", 1], ["Gerente General", 1], ["Vicepresidente de Ventas", 1], ["Fundador y CEO", 1], ["Socio Director", 1], ["Presidente", 1], ["Director Ejecutivo", 1], ["Director Comercial", 2], ["Gerente de Ventas", 2], ["Ejecutivo de Cuentas", 2], ["Representante de Ventas", 2], ["Jefa de Marketing", 2], ["Responsable de Cuentas Clave", 2], ["Gerente de Marketing", 2], ["Directora de Marketing", 2], ["Analista Financiero", 3], ["Ingeniera de Software", 3], ["Asistente de Dirección", 3], ["Coordinador de Logística", 3], ["Directora de Recursos Humanos", 3], ["Contador", 3], ["Jefe de Almacén", 3], ["Asistente Administrativa", 3], ["Técnico de Soporte", 3], ["Abogada Corporativa", 3]],
  pt: [["Diretor Executivo", 1], ["Sócio-Diretor", 1], ["Gerente Geral", 1], ["Diretor Comercial", 2], ["Gerente de Contas", 2], ["Analista de Vendas", 2], ["Engenheiro de Software", 3], ["Analista Financeira", 3], ["Assistente Administrativo", 3]],
  fr: [["Directrice Générale", 1], ["Président", 1], ["Fondateur et PDG", 1], ["Directeur des Ventes", 2], ["Responsable Marketing", 2], ["Chargé de Compte", 2], ["Ingénieur Logiciel", 3], ["Comptable", 3], ["Assistante de Direction", 3]],
  de: [["Geschäftsführer", 1], ["Geschäftsführerin", 1], ["Inhaber", 1], ["Vertriebsleiter", 2], ["Leiter Marketing", 2], ["Softwareentwickler", 3], ["Buchhalterin", 3], ["Sachbearbeiter", 3]],
};

/* ---------------------------------------------------------------- segments */

interface Seg { name: string; n: number; model: "B2B" | "B2C" | "B2B2C"; industries: string[]; words: string[]; small: number; large: number; strong: boolean; weak: boolean }
const SEGMENTS: Seg[] = [
  { name: "software", n: 70, model: "B2B", industries: ["B2B software", "Workflow software", "Data platforms", "Security software", "Vertical SaaS"], words: ["Software", "Labs", "Systems", "Cloud", "Technologies", "Digital", "Data"], small: 0.28, large: 0.18, strong: true, weak: false },
  { name: "logistics technology", n: 45, model: "B2B", industries: ["Logistics technology", "Freight software", "Fleet telematics", "Warehouse automation"], words: ["Logistics", "Freight", "Freightworks", "Cargo", "Fleet", "Supply Chain"], small: 0.28, large: 0.2, strong: true, weak: false },
  { name: "payments", n: 35, model: "B2B", industries: ["Payments", "Merchant acquiring", "Treasury software", "Invoicing and settlement"], words: ["Payments", "Pay", "Financial", "Settlements", "Ledger"], small: 0.26, large: 0.2, strong: true, weak: false },
  { name: "industrial manufacturing", n: 40, model: "B2B", industries: ["Industrial manufacturing", "Machined components", "Packaging manufacturing"], words: ["Industries", "Manufacturing", "Works", "Fabrication", "Metals"], small: 0.25, large: 0.25, strong: false, weak: false },
  { name: "wholesale distribution", n: 30, model: "B2B", industries: ["Wholesale distribution", "Industrial supplies", "Food service distribution"], words: ["Distribution", "Wholesale", "Trading", "Supply"], small: 0.3, large: 0.2, strong: false, weak: false },
  { name: "insurance brokerage", n: 25, model: "B2B", industries: ["Insurance brokerage", "Risk advisory"], words: ["Insurance Brokers", "Risk Partners", "Assurance"], small: 0.3, large: 0.15, strong: false, weak: false },
  { name: "healthcare services", n: 25, model: "B2B2C", industries: ["Healthcare services", "Diagnostic labs", "Clinic networks"], words: ["Health", "Clinics", "Care", "Medical"], small: 0.25, large: 0.25, strong: false, weak: false },
  { name: "energy and utilities", n: 20, model: "B2B", industries: ["Renewable energy", "Utilities services"], words: ["Energy", "Power", "Renewables"], small: 0.2, large: 0.3, strong: false, weak: false },
  { name: "telecom", n: 12, model: "B2B2C", industries: ["Telecom services", "Network infrastructure"], words: ["Networks", "Telecom"], small: 0.15, large: 0.35, strong: false, weak: false },
  { name: "construction", n: 15, model: "B2B", industries: ["Construction and engineering", "Building services"], words: ["Construction", "Builders", "Engineering"], small: 0.3, large: 0.2, strong: false, weak: false },
  { name: "marketing agency", n: 30, model: "B2B", industries: ["Marketing agency", "Creative agency", "Media buying"], words: ["Creative", "Media", "Studio", "Agency", "Communications"], small: 0.55, large: 0.04, strong: false, weak: true },
  { name: "management consulting", n: 25, model: "B2B", industries: ["Management consulting", "Advisory services"], words: ["Advisory", "Consulting", "Partners"], small: 0.5, large: 0.08, strong: false, weak: true },
  { name: "consumer apps", n: 12, model: "B2C", industries: ["Consumer mobile apps", "Games"], words: ["Apps", "Play", "Mobile", "Interactive"], small: 0.4, large: 0.1, strong: false, weak: false },
  { name: "retail", n: 22, model: "B2C", industries: ["Retail clothing", "Home goods retail", "Consumer electronics retail"], words: ["Retail", "Stores", "Outfitters", "Home", "Apparel"], small: 0.25, large: 0.25, strong: false, weak: false },
  { name: "hospitality", n: 14, model: "B2C", industries: ["Restaurants", "Hotels", "Brewing and beverages"], words: ["Kitchens", "Hospitality", "Restaurants", "Foods", "Brewing"], small: 0.3, large: 0.15, strong: false, weak: false },
];
const SEG_STRONG = new Set(SEGMENTS.filter((s) => s.strong).map((s) => s.name));
const SEG_WEAK = new Set(SEGMENTS.filter((s) => s.weak).map((s) => s.name));

export const SELLER = {
  name: "Orrery Revenue Software",
  sells: "A revenue operations platform for B2B sales teams: pipeline, forecasting and territory planning. It is not a payments product.",
  icp: "B2B companies with 200 to 5000 employees that sell to other businesses and run a sales team. Strong fit: software, logistics technology, payments. Weak fit: agencies, consultancies, and companies that sell only to consumers.",
  tier_rule: "Tier 3: consumer-only business, agency or consultancy. Tier 1: B2B, 200 to 5000 employees, in a strong-fit segment (software, logistics technology, payments). Tier 2: any other B2B company that is either in the employee range or in a strong-fit segment. Tier 3: everything else.",
};

export function tierFor(c: { segment: string; employees: number; business_model: string }): WTier {
  if (c.business_model === "B2C" || SEG_WEAK.has(c.segment)) return 3;
  const inRange = c.employees >= 200 && c.employees <= 5000;
  const strong = SEG_STRONG.has(c.segment);
  if (strong && inRange) return 1;
  return inRange || strong ? 2 : 3;
}

/* ------------------------------------------------------------ company names */

const COMPOUND_A = ["Alder", "Amber", "Ash", "Birch", "Cedar", "Cinder", "Clover", "Copper", "Coral", "Crest", "Dawn", "Drift", "Elm", "Fable", "Fern", "Flint", "Frost", "Garnet", "Glen", "Grove", "Hazel", "Heron", "Ivory", "Jade", "Lark", "Linden", "Maple", "Mist", "Moss", "Oriel", "Pebble", "Quill", "Raven", "Reed", "Sable", "Sedge", "Slate", "Sparrow", "Thorn", "Umber", "Willow", "Wren", "Yew", "Teal", "Briar", "Cobble"];
const COMPOUND_B = ["brook", "field", "gate", "hollow", "mere", "moor", "ridge", "stone", "vale", "wick", "wood", "worth", "ford", "haven", "land", "well", "cross", "bay", "fall", "marsh", "dale", "croft", "by", "ton"];
const SYL = ["ve", "lo", "ra", "mi", "ta", "ko", "ne", "sa", "du", "bre", "tri", "zan", "qui", "mor", "vel", "kas", "dra", "fen", "gal", "hol", "jun", "lum", "nor", "ora", "pri", "sel", "tev", "uma", "wen", "yar", "zor", "bel", "cal", "dev", "ish", "kel", "ven", "pal", "ros", "tam"];
const SYL_END = ["a", "o", "is", "or", "an", "en", "ix", "ara", "ine", "ova", "ex", "ia", "um", "on"];
/** Names this fictional world must never contain, real brands and the sample file's own companies. */
const BLOCKED = ["apple", "google", "microsoft", "amazon", "oracle", "sap", "salesforce", "stripe", "paypal", "visa", "mastercard", "dhl", "fedex", "ups", "maersk", "siemens", "bosch", "ibm", "intel", "cisco", "adobe", "shopify", "square", "adyen", "klarna", "hubspot", "zoom", "slack", "uber", "lyft", "airbnb", "tesla", "ford", "toyota", "nestle", "unilever", "kpmg", "deloitte", "pwc", "accenture", "mckinsey", "bain", "hsbc", "santander", "bbva", "chase", "apollo", "hunter", "zerobounce", "neverbounce", "anthropic", "openai", "meta", "netflix", "spotify", "samsung", "sony", "nike", "adidas", "zara", "ikea", "brightwater", "kestrel", "harrow", "tallgrass", "oakline"];

const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ø/g, "o").replace(/Ø/g, "O").replace(/ł/g, "l").replace(/Ł/g, "L").replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/đ/g, "d").replace(/ı/g, "i").replace(/İ/g, "I").replace(/ř/g, "r").replace(/ľ/g, "l");
const slug = (s: string) => ascii(s).toLowerCase().replace(/[^a-z]/g, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------------------------------------------------------- builder */

interface Draft {
  kind: "person" | "company_only";
  person: WorldPerson | null;
  company: WorldCompany | null; // truth
  first: string; last: string; badge: string;
  company_name: string; title: string; email: string; website: string; country: string; linkedin: string;
  ticket: string; diet: string; access: string; notes: string;
  mess: string[];
  touched: Set<string>;
}

export interface Built { world: World; csv: string }

export function buildWorld(seed = SEED): Built {
  const rand = mulberry32(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const range = (lo: number, hi: number) => lo + int(hi - lo + 1);
  const chance = (p: number) => rand() < p;
  const pick = <X>(a: readonly X[]): X => a[int(a.length)];
  const shuffle = <X>(a: X[]): X[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const weighted = <X extends { w: number }>(a: X[]): X => { let r = rand() * a.reduce((n, x) => n + x.w, 0); for (const x of a) { r -= x.w; if (r <= 0) return x; } return a[a.length - 1]; };

  /* ---- companies ---- */
  const usedKeys = new Set<string>();
  const usedDomains = new Set<string>();
  const companies: WorldCompany[] = [];
  const stemOf = new Map<string, string>(); // company id -> brand stem
  const segOf = new Map<string, Seg>();
  const reserveKey = (name: string) => { const k = companyKey(name); if (usedKeys.has(k)) return false; usedKeys.add(k); return true; };
  const blocked = (name: string) => { const w = ascii(name).toLowerCase().split(/[^a-z]+/); return BLOCKED.some((b) => w.includes(b)); };

  const newStem = () => {
    for (;;) {
      let s: string;
      const r = rand();
      if (r < 0.5) s = pick(COMPOUND_A) + pick(COMPOUND_B);
      else if (r < 0.9) s = cap(pick(SYL) + pick(SYL) + (chance(0.4) ? pick(SYL_END) : ""));
      else s = `${pick(COMPOUND_A)} & ${cap(pick(SYL) + pick(SYL_END))}`;
      s = s.replace(/(.)\1\1/g, "$1$1");
      if (!blocked(s)) return s;
    }
  };
  const employeesFor = (seg: Seg) => {
    const r = rand();
    if (r < seg.small) return range(9, 190);
    if (r > 1 - seg.large) return Math.round(range(5200, 70000) / 100) * 100;
    return Math.round(Math.exp(Math.log(200) + rand() * (Math.log(5000) - Math.log(200))));
  };
  const makeDomain = (stem: string, fullName: string, style: "stem" | "full" | "auto") => {
    const base = slug(stem.includes("&") ? stem.split("&").map((x) => x.trim().slice(0, 4)).join("") : stem);
    const options = style === "full" ? [slug(fullName)] : style === "stem" ? [base] : [base, base, base, slug(fullName), `${base}group`, base.slice(0, 3) + slug(fullName).slice(-3), `get${base}`, `${base}hq`];
    for (const o of options.concat([`${base}${pick(["co", "inc", "global", "intl"])}`])) {
      const d = `${o}.example`;
      if (o.length >= 3 && !usedDomains.has(d)) { usedDomains.add(d); return d; }
    }
    let i = 2; while (usedDomains.has(`${base}x${i}.example`)) i++; // never reached in practice; keeps names digit-free in the common case
    const d = `${base}${"x".repeat(i)}.example`; usedDomains.add(d); return d;
  };

  let counter = 0;
  const addCompany = (o: { name: string; stem: string; seg: Seg; employees?: number; country?: string; parent?: WorldCompany; domainStyle?: "stem" | "full" | "auto"; list_status?: WorldCompany["list_status"]; model?: WorldCompany["business_model"] }) => {
    const country = o.country ?? weighted(COUNTRIES).name;
    const employees = o.employees ?? employeesFor(o.seg);
    const model = o.model ?? (o.seg.model === "B2B2C" ? (chance(0.5) ? "B2B" : "B2B2C") : o.seg.model);
    const domain = o.parent ? o.parent.domain : makeDomain(o.stem, o.name, o.domainStyle ?? "auto");
    const c: WorldCompany = {
      id: `co${String(++counter).padStart(3, "0")}`, name: o.name, aliases: [], domain, parent_id: o.parent?.id ?? null, segment: o.seg.name, employees,
      industry: pick(o.seg.industries), business_model: model, country, tier: 1,
      catch_all: o.parent ? o.parent.catch_all : chance(0.22),
      email_pattern: weighted([{ v: "first.last", w: 50 }, { v: "flast", w: 18 }, { v: "first", w: 12 }, { v: "firstl", w: 8 }, { v: "first_last", w: 7 }, { v: "last.first", w: 5 }]).v,
      list_status: o.list_status ?? null,
    };
    if (o.parent) c.email_pattern = o.parent.email_pattern;
    c.tier = tierFor(c);
    companies.push(c); stemOf.set(c.id, o.stem); segOf.set(c.id, o.seg);
    return c;
  };
  const compose = (seg: Seg, stem: string) => {
    const r = rand();
    return r < 0.12 ? stem : `${stem} ${pick(seg.words)}`;
  };
  const usedStems = new Set<string>();
  const freshName = (seg: Seg) => {
    for (;;) {
      const stem = newStem();
      if (usedStems.has(stem)) continue;
      const name = compose(seg, stem);
      if (!blocked(name) && reserveKey(name)) { usedStems.add(stem); return { stem, name }; }
    }
  };

  const bySeg = (n: string) => SEGMENTS.find((s) => s.name === n)!;
  // The seller's own lists come first: a competitor to exclude and a customer to skip.
  reserveKey("Rivalcrest Systems"); reserveKey("Pinefold");
  const rival = addCompany({ name: "Rivalcrest Systems", stem: "Rivalcrest", seg: bySeg("software"), employees: 900, country: "United States", domainStyle: "stem", model: "B2B" });
  rival.list_status = "excluded"; rival.aliases.push("Rivalcrest");
  const customer = addCompany({ name: "Pinefold", stem: "Pinefold", seg: bySeg("logistics technology"), employees: 1400, country: "United Kingdom", domainStyle: "stem", model: "B2B" });
  customer.list_status = "existing_customer";
  // Pairs: two different companies with similar names, in different segments and sizes.
  const pairs: [WorldCompany, WorldCompany][] = [];
  for (let i = 0; i < 12; i++) {
    const segA = pick(SEGMENTS.filter((s) => s.strong || s.name === "industrial manufacturing" || s.name === "wholesale distribution"));
    let a: { stem: string; name: string };
    do a = freshName(segA); while (a.name === a.stem);
    const A = addCompany({ name: a.name, stem: a.stem, seg: segA, employees: range(260, 4200), domainStyle: "stem", model: "B2B" });
    const segB = pick(SEGMENTS.filter((s) => s.name !== segA.name && !s.strong));
    let nameB = `${A.name} ${pick(segB.words)}`;
    while (!reserveKey(nameB)) nameB = `${a.stem} ${pick(segB.words)} ${pick(["Group", "International", "Partners", "Holdings"])}`;
    const B = addCompany({ name: nameB, stem: a.stem, seg: segB, employees: range(12, 160), country: A.country, domainStyle: "full" });
    pairs.push([A, B]);
  }
  // Subsidiaries on a parent's domain, with the parent recorded.
  const subs: WorldCompany[] = [];
  const parentStock: WorldCompany[] = [];
  for (let i = 0; i < 8; i++) {
    const seg = pick(SEGMENTS.filter((s) => !s.weak && s.n > 20));
    const { stem, name } = freshName(seg);
    parentStock.push(addCompany({ name, stem, seg, employees: range(3000, 40000), model: "B2B", domainStyle: "stem" }));
  }
  for (let i = 0; i < 14; i++) {
    const P = parentStock[i % parentStock.length];
    const seg = pick(SEGMENTS.filter((s) => s.n > 20));
    let name = `${stemOf.get(P.id)!.replace(/ & .*/, "")} ${pick(seg.words)}`;
    while (!reserveKey(name)) name = `${stemOf.get(P.id)!.replace(/ & .*/, "")} ${pick(seg.words)} ${pick(["Group", "Europe", "Americas", "Services", "Holdings"])}`;
    subs.push(addCompany({ name, stem: stemOf.get(P.id)!, seg, employees: range(60, 2500), country: P.country, parent: P, model: seg.model === "B2C" ? "B2B2C" : seg.model }));
  }
  // The rest, filling each segment up to its quota and the total to 420.
  const count = (seg: string) => companies.filter((c) => c.segment === seg).length;
  for (const seg of SEGMENTS) while (count(seg.name) < seg.n && companies.length < COMPANIES) { const { stem, name } = freshName(seg); addCompany({ name, stem, seg }); }
  while (companies.length < COMPANIES) { const seg = pick(SEGMENTS); const { stem, name } = freshName(seg); addCompany({ name, stem, seg }); }

  const byId = new Map(companies.map((c) => [c.id, c]));

  /* ---- delegations ---- */
  const special = new Set<string>([rival.id, customer.id, ...pairs.flat().map((c) => c.id), ...subs.map((c) => c.id), ...parentStock.map((c) => c.id)]);
  const plain = companies.filter((c) => !special.has(c.id));
  const sizeRank = (list: WorldCompany[]) => [...list].sort((a, b) => b.employees - a.employees);
  const big = [
    ...sizeRank(plain.filter((c) => c.tier === 1)).slice(0, 2),
    ...sizeRank(plain.filter((c) => c.tier === 2 && c.employees > 5000)).slice(0, 3),
    ...sizeRank(plain.filter((c) => c.tier === 3 && c.employees > 5000)).slice(0, 2),
  ];
  const bigIds = new Set(big.map((c) => c.id));
  const mid = shuffle(plain.filter((c) => !bigIds.has(c.id) && c.employees >= 150)).slice(0, 22);
  const midIds = new Set(mid.map((c) => c.id));
  const attendCount = new Map<string, number>();
  for (const c of big) attendCount.set(c.id, range(30, 60));
  for (const c of mid) attendCount.set(c.id, range(6, 20));
  attendCount.set(rival.id, 5); attendCount.set(customer.id, 4);
  for (const [A, B] of pairs) { attendCount.set(A.id, range(3, 8)); attendCount.set(B.id, range(4, 9)); }
  for (const P of parentStock) attendCount.set(P.id, range(2, 6));
  for (const S of subs) attendCount.set(S.id, range(2, 5));
  // Some companies appear only as unassigned tickets: a company name and nobody to go with it.
  const tailAll = plain.filter((c) => !bigIds.has(c.id) && !midIds.has(c.id));
  const companyOnlyFirst = new Set(shuffle(tailAll).slice(0, 100).map((c) => c.id));
  const tail = tailAll.filter((c) => !companyOnlyFirst.has(c.id));
  for (const c of tail) { const r = rand(); attendCount.set(c.id, r < 0.46 ? 1 : r < 0.74 ? 2 : r < 0.86 ? 3 : r < 0.92 ? 4 : r < 0.96 ? 5 : r < 0.98 ? 6 : 7); }

  const N = TOTAL_ROWS;
  const C_ONLY = Math.round(0.15 * N);
  const PERSON_ROWS = N - C_ONLY;
  const N_NON = Math.round(0.03 * PERSON_ROWS);
  const N_DUP = Math.round(0.03 * PERSON_ROWS);
  const N_TWO = 8;
  const ATTENDEES = PERSON_ROWS - N_NON - N_DUP - N_TWO - NATIVE.length;
  const total = () => [...attendCount.values()].reduce((a, b) => a + b, 0);
  for (let guard = 0; total() !== ATTENDEES && guard < 20000; guard++) {
    const c = pick(tail);
    const n = attendCount.get(c.id)!;
    if (total() < ATTENDEES) { if (n < 7) attendCount.set(c.id, n + 1); else { const m = pick(mid); attendCount.set(m.id, attendCount.get(m.id)! + 1); } }
    else if (n > 1) attendCount.set(c.id, n - 1);
    else { const m = pick(mid); if (attendCount.get(m.id)! > 6) attendCount.set(m.id, attendCount.get(m.id)! - 1); }
  }

  /* ---- people ---- */
  const people: WorldPerson[] = [];
  const titles: Record<string, WTier> = {};
  const usedNames = new Set<string>(["maya serrano", "omar haddad", "ana beltran", "ines duarte", "petra novak", "sam okafor", "maya ortiz", "dan whitlock"]);
  const usedEmails = new Set<string>();
  const usedLinkedin = new Set<string>();
  let pcount = 0;
  const cultureOf = (country: string) => COUNTRIES.find((c) => c.name === country)?.culture ?? "anglo";
  const fullNameOf = (first: string, last: string) => `${first} ${last}`;
  const localPart = (pattern: string, first: string, last: string) => {
    const f = slug(first), l = slug(last);
    switch (pattern) {
      case "flast": return f[0] + l;
      case "first": return f;
      case "firstl": return f + l[0];
      case "first_last": return `${f}_${l}`;
      case "last.first": return `${l}.${f}`;
      default: return `${f}.${l}`;
    }
  };
  const emailFor = (c: WorldCompany, first: string, last: string) => {
    let e = `${localPart(c.email_pattern, first, last)}@${c.domain}`;
    for (let i = 2; usedEmails.has(e); i++) e = `${localPart(c.email_pattern, first, last)}${i}@${c.domain}`;
    usedEmails.add(e);
    return e;
  };
  const linkedinFor = (first: string, last: string) => {
    const base = `${slug(first)}-${slug(last)}`;
    for (let i = 0; ; i++) {
      const u = `https://www.linkedin.com/in/${base}-${(0x1000 + int(0xefff)).toString(16)}`;
      if (!usedLinkedin.has(u)) { usedLinkedin.add(u); return u; }
    }
  };
  const nameFor = (culture: Culture) => {
    for (let tries = 0; ; tries++) {
      // Most people share their company's culture, some do not.
      const a = tries < 60 && chance(0.82) ? culture : pick(Object.keys(NAMES) as Culture[]);
      const b = chance(0.88) ? a : pick(Object.keys(NAMES) as Culture[]);
      const first = pick(NAMES[a].first), last = pick(NAMES[b].last);
      if (!usedNames.has(fullNameOf(first, last).toLowerCase()) || tries > 200) { usedNames.add(fullNameOf(first, last).toLowerCase()); return { first, last }; }
    }
  };
  const titleFor = (c: WorldCompany, culture: Culture) => {
    const small = c.employees < 60;
    const u = rand();
    const p1 = small ? 0.45 : 0.14;
    const tier: WTier = u < p1 ? 1 : u < p1 + (small ? 0.35 : 0.46) ? 2 : 3;
    let t: T;
    const r = rand();
    if (r < 0.04) t = INFLATED[int(INFLATED.length)];
    else if (r < 0.08) t = AMBIGUOUS[int(AMBIGUOUS.length)];
    else if (LOCAL[culture] && r < 0.4) { const pool = LOCAL[culture]!.filter((x) => x[1] === tier); t = pool.length ? pick(pool) : pick(LOCAL[culture]!); }
    else if (tier === 1) t = pick(T1);
    else {
      const base = pick(tier === 2 ? T2_BASE : T3_BASE);
      const pre = rand() < 0.2 ? "Senior " : rand() < 0.08 ? "Junior " : "";
      t = [pre + base, tier];
    }
    // Real files vary case and abbreviations; the same title string always has the same truth.
    let text = t[0];
    const v = rand();
    if (v < 0.05) text = text.toLowerCase(); else if (v < 0.08) text = text.toUpperCase();
    else if (v < 0.12) text = text.replace("Vice President", "VP").replace("Senior", "Sr.");
    titles[text.toLowerCase()] = t[1];
    return { title: text, tier: t[1] };
  };
  const addPerson = (c: WorldCompany | null, o: Partial<WorldPerson> & { kind?: WorldPerson["kind"]; attending: boolean; culture?: Culture }) => {
    const culture = o.culture ?? cultureOf(c?.country ?? weighted(COUNTRIES).name);
    const nm = o.first && o.last ? { first: o.first, last: o.last } : nameFor(culture);
    const ti = o.title ? { title: o.title, tier: (o.title_tier ?? null) as WTier | null } : c ? titleFor(c, culture) : { title: "", tier: null };
    const p: WorldPerson = {
      id: `p${String(++pcount).padStart(4, "0")}`, company_id: c?.id ?? null, listed_company_id: null, first: nm.first, last: nm.last, full_name: fullNameOf(nm.first, nm.last),
      title: ti.title, title_tier: ti.tier, there: true, attending: o.attending,
      email: o.email ?? (c ? emailFor(c, nm.first, nm.last) : `${slug(nm.first)}.${slug(nm.last)}@${pick(WEBMAIL_DOMAINS)}`),
      linkedin: linkedinFor(nm.first, nm.last), kind: o.kind ?? "employee",
    };
    people.push(p);
    return p;
  };

  const attendees: WorldPerson[] = [];
  for (const c of companies) for (let i = 0; i < (attendCount.get(c.id) ?? 0); i++) attendees.push(addPerson(c, { attending: true }));
  // Staff who did not register: what a discovery search finds.
  for (const c of companies) {
    if (c.list_status) continue;
    const n = c.employees < 40 ? range(1, 2) : range(3, 6);
    for (let i = 0; i < n; i++) {
      const p = addPerson(c, { attending: false });
      // Discovery looks for buyers, so most extras are in the first two tiers.
      if (p.title_tier === 3 && chance(0.7)) { const t = pick(T1.concat(T2_BASE.map((x): T => [x, 2]))); p.title = t[0]; p.title_tier = t[1]; titles[t[0].toLowerCase()] = t[1]; }
    }
  }
  const nonCompany: WorldPerson[] = [];
  const UNIS = ["University of Kessenbrook", "Universidad Politécnica de Alvareda", "Halvern Institute of Technology", "Université de Montclair-Sud", "Escola Superior de Veraneda", "Technische Hochschule Ostmark"];
  const OUTLETS = ["The Meridian Courier", "Revista Comercio Hoy", "Hollis Weekly", "Radio Ostmark", "Trade Ledger Magazine", "Die Handelsstimme"];
  const kinds: ("student" | "press" | "self_employed")[] = [...Array(17).fill("student"), ...Array(11).fill("press"), ...Array(N_NON - 28).fill("self_employed")];
  for (const k of kinds) {
    const culture = weighted(COUNTRIES).culture;
    const nm = nameFor(culture);
    const title = k === "student" ? pick(["Student", "Master's Student", "PhD Candidate"]) : k === "press" ? pick(["Journalist", "Reporter", "Editor", "Freelance Writer"]) : pick(["Independent Consultant", "Freelance Designer", "Founder", "Consultant"]);
    const uni = pick(UNIS);
    const email = k === "student" ? `${slug(nm.first)}.${slug(nm.last)}@${slug(uni).slice(0, 12)}.example` : `${slug(nm.first)}.${slug(nm.last)}@${pick(WEBMAIL_DOMAINS)}`;
    if (!usedEmails.has(email)) usedEmails.add(email);
    const p = addPerson(null, { first: nm.first, last: nm.last, title, title_tier: 3, kind: k, attending: true, email, culture });
    nonCompany.push(p);
    titles[title.toLowerCase()] = 3;
  }
  // The same name at two companies: pairs of different people a name search cannot tell apart.
  const homonymRows: [WorldPerson, WorldPerson][] = [];
  {
    const pool = shuffle(attendees.filter((p) => p.company_id !== rival.id && p.company_id !== customer.id));
    for (let i = 0; homonymRows.length < 6 && i < pool.length - 1; i += 2) {
      const a = pool[i], b = pool[i + 1];
      if (a.company_id === b.company_id) continue;
      b.first = a.first; b.last = a.last; b.full_name = a.full_name;
      b.email = emailFor(byId.get(b.company_id!)!, b.first, b.last);
      b.linkedin = linkedinFor(b.first, b.last);
      homonymRows.push([a, b]);
    }
  }
  // A few people carry their name in its native script on the badge.
  const nativeBadge = new Map<string, string>();
  for (const [i, [f, l, nf, nl]] of NATIVE.entries()) {
    const c = pick(companies.filter((x) => x.country === "Japan" || x.country === "South Korea" || x.country === "India" || x.country === "Germany"));
    const p = addPerson(c, { first: f, last: l, attending: true, culture: "asia" });
    attendees.push(p); attendCount.set(c.id, (attendCount.get(c.id) ?? 0) + 1);
    nativeBadge.set(p.id, nl + nf);
    void i;
  }
  // People registered under an old employer.
  const staleSet = shuffle(attendees.filter((p) => p.company_id !== rival.id && p.company_id !== customer.id && !homonymRows.flat().includes(p))).slice(0, Math.round(0.04 * PERSON_ROWS));
  for (const p of staleSet) {
    const old = pick(companies.filter((c) => c.id !== p.company_id && c.list_status === null && c.domain !== byId.get(p.company_id!)!.domain));
    p.listed_company_id = old.id; p.there = false;
  }

  /* ---- drafts ---- */
  const countryText = (name: string) => {
    const c = COUNTRIES.find((x) => x.name === name)!;
    const r = rand();
    return r < 0.55 ? c.name : r < 0.7 ? c.code : r < 0.85 ? c.local : r < 0.92 ? c.name.toUpperCase() : `${c.name} `;
  };
  const DIET = ["", "", "", "", "", "", "Vegetarian", "Vegan", "Gluten-free", "Halal", "Kosher", "No pork", "Lactose intolerant", "Nut allergy", "none", "N/A", "Pescatarian", "Sin gluten", "Végétarien"];
  const TICKET = [{ v: "Delegate", w: 60 }, { v: "Exhibitor", w: 14 }, { v: "VIP", w: 6 }, { v: "Speaker", w: 4 }, { v: "Sponsor", w: 6 }, { v: "Delegate (early bird)", w: 10 }];
  const blank = (): Draft => ({ kind: "person", person: null, company: null, first: "", last: "", badge: "", company_name: "", title: "", email: "", website: "", country: "", linkedin: "", ticket: weighted(TICKET).v, diet: pick(DIET), access: chance(0.02) ? pick(["Wheelchair access", "Step-free route", "Sign language interpreter", "Quiet room"]) : "", notes: "", mess: [], touched: new Set() });
  const siteTrue = (c: WorldCompany) => {
    const r = rand();
    return r < 0.4 ? `https://www.${c.domain}/` : r < 0.65 ? c.domain : r < 0.8 ? `www.${c.domain}` : r < 0.9 ? `http://${c.domain}` : `https://${c.domain}/en`;
  };
  const drafts: Draft[] = [];
  const draftsOfPerson = new Map<string, Draft>();
  for (const p of attendees) {
    const d = blank();
    const c = byId.get(p.company_id!)!;
    const listed = p.listed_company_id ? byId.get(p.listed_company_id)! : c;
    d.person = p; d.company = c;
    d.first = p.first; d.last = p.last; d.badge = nativeBadge.get(p.id) ?? (chance(0.12) ? p.first.split("-")[0] : p.first);
    d.company_name = listed.name; d.title = p.title; d.email = p.email; d.country = countryText(listed.country); d.website = siteTrue(listed);
    d.linkedin = chance(0.14) ? p.linkedin : "";
    if (p.listed_company_id) {
      d.mess.push("stale_employer"); d.touched.add("company");
      // The old address no longer works, or they left it blank.
      d.email = chance(0.5) ? "" : `${localPart(listed.email_pattern, p.first, p.last)}@${listed.domain}`;
      d.touched.add("email");
    }
    drafts.push(d); draftsOfPerson.set(p.id, d);
  }
  for (const p of nonCompany) {
    const d = blank();
    d.person = p; d.company = null;
    d.first = p.first; d.last = p.last; d.badge = p.first;
    d.title = p.title; d.email = p.email; d.country = countryText(weighted(COUNTRIES).name);
    d.ticket = p.kind === "student" ? "Student" : p.kind === "press" ? "Press" : "Delegate";
    d.company_name = p.kind === "student" ? (chance(0.7) ? pick(UNIS) : "Student") : p.kind === "press" ? (chance(0.7) ? pick(OUTLETS) : "Press") : pick(["Self employed", "Freelance", "Independent", "Autónomo", "Self-employed", "Freelancer", "Own business"]);
    d.website = ""; d.mess.push(p.kind === "student" ? "student" : p.kind === "press" ? "press" : "self_employed", "non_company");
    for (const f of ["company", "name", "title", "email", "website"]) d.touched.add(f);
    drafts.push(d);
  }
  // The same person registered at a second company.
  const twoCo = shuffle(attendees.filter((p) => p.there && p.company_id !== rival.id && p.company_id !== customer.id && !homonymRows.flat().includes(p))).slice(0, N_TWO);
  for (const p of twoCo) {
    const first = draftsOfPerson.get(p.id)!;
    const other = pick(companies.filter((c) => c.id !== p.company_id && c.list_status === null));
    const d = blank();
    d.person = p; d.company = byId.get(p.company_id!)!;
    d.first = p.first; d.last = p.last; d.badge = p.first; d.company_name = other.name; d.title = p.title; d.email = chance(0.5) ? p.email : ""; d.country = countryText(other.country); d.website = siteTrue(other);
    d.mess.push("same_person_two_companies"); first.mess.push("same_person_two_companies");
    for (const f of ["company", "name", "title", "email", "website"]) d.touched.add(f);
    first.touched.add("company"); first.touched.add("name");
    drafts.push(d);
  }
  // Company-only rows: unassigned tickets with a company name and nobody to go with it.
  const coOnlyCounts = new Map<string, number>();
  for (const id of companyOnlyFirst) coOnlyCounts.set(id, 1);
  let left = C_ONLY - companyOnlyFirst.size;
  const coIds = [...companyOnlyFirst];
  for (let i = 0; left > 0; i++) {
    const withPeople = chance(0.46);
    const id = withPeople ? pick(companies.filter((c) => (attendCount.get(c.id) ?? 0) > 0 && c.list_status === null)).id : coIds[int(coIds.length)];
    coOnlyCounts.set(id, (coOnlyCounts.get(id) ?? 0) + 1); left--;
    void i;
  }
  for (const [id, n] of [...coOnlyCounts].sort()) for (let i = 0; i < n; i++) {
    const c = byId.get(id)!;
    const d = blank();
    d.kind = "company_only"; d.company = c; d.company_name = c.name; d.country = countryText(c.country); d.website = siteTrue(c);
    d.ticket = pick(["Exhibitor", "Delegate", "Sponsor", "Delegate"]);
    d.mess.push("company_only");
    for (const f of ["name", "title", "email"]) d.touched.add(f);
    drafts.push(d);
  }

  /* ---- mess ---- */
  const hard: HardCase[] = [];
  const stats: MessStat[] = [];
  const personDrafts = () => drafts.filter((d) => d.kind === "person");
  const free = (d: Draft, ...fields: string[]) => fields.every((f) => !d.touched.has(f));
  const take = (n: number, ok: (d: Draft) => boolean, fields: string[], tag: string, apply: (d: Draft, i: number) => void, pool: Draft[] = personDrafts()) => {
    const chosen = shuffle(pool.filter((d) => ok(d) && free(d, ...fields))).slice(0, n);
    chosen.forEach((d, i) => { apply(d, i); d.mess.push(tag); for (const f of fields) d.touched.add(f); });
    return chosen;
  };
  const record = (tag: string, of: MessStat["of"], rate: number | null, target: number, actual: number, note: string) => stats.push({ tag, of, stated_rate: rate, target, actual, note });
  const pr = (rate: number) => Math.round(rate * PERSON_ROWS);

  // Hard cases first, so the rate-based noise cannot land on them.
  {
    // One assistant registers a team under one address.
    const sizes = [9, 6];
    const teams = shuffle(mid.filter((c) => (attendCount.get(c.id) ?? 0) >= 12 && c.list_status === null)).slice(0, 2);
    teams.forEach((c, k) => {
      const rows = personDrafts().filter((d) => d.company === c && !d.mess.includes("stale_employer") && !d.mess.includes("same_person_two_companies")).slice(0, sizes[k]);
      const assistant = rows[0];
      for (const d of rows) { d.email = `events@${c.domain}`; d.notes = `Registered by ${assistant.first} ${assistant.last} (assistant)`; d.mess.push("shared_team_email"); d.touched.add("email"); }
      hard.push({ id: `shared_team_${k + 1}`, kind: "shared_team_email", description: `${rows.length} people at one company registered by an assistant on events@${c.domain}; each has a different real address.`, rows: [] });
      (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = rows;
    });
    record("shared_team_email", "fixed", null, 15, drafts.filter((d) => d.mess.includes("shared_team_email")).length, "Two teams, 9 and 6 people, each registered by an assistant on one shared address.");

    // A travel agency registers people from several unrelated companies on its own domain.
    const agencyRows: Draft[] = [];
    const seen = new Set<string>();
    for (const d of shuffle(personDrafts().filter((x) => x.company && free(x, "email", "company") && x.person!.there))) {
      if (agencyRows.length >= 11) break;
      if (seen.has(d.company!.id) && agencyRows.length < 7) continue;
      seen.add(d.company!.id); agencyRows.push(d);
    }
    for (const d of agencyRows) { d.email = `${slug(d.first)}.${slug(d.last)}@${AGENCY_DOMAIN}`; d.notes = "Booked via Pavilion Event Travel"; d.mess.push("agency_domain"); d.touched.add("email"); }
    hard.push({ id: "agency_domain", kind: "one_domain_many_companies", description: `A travel agency registered ${agencyRows.length} people from ${seen.size} unrelated companies, all on @${AGENCY_DOMAIN}.`, rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = agencyRows;
    record("agency_domain", "fixed", null, 11, agencyRows.length, "People from unrelated companies share one agency email domain.");

    // Fake address on a real domain.
    const fake = take(12, (d) => !!d.company && d.company.list_status === null, ["email"], "fake_address_real_domain", (d, i) => { d.email = `${["test", "asdf", "info", "noemail", "tbd", "na", "nobody", "xx", "none", "registration", "sales", "contact"][i]}@${d.company!.domain}`; });
    hard.push({ id: "fake_address", kind: "fake_address_on_real_domain", description: "A real company domain with a made-up mailbox: test@, asdf@, tbd@.", rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = fake;
    record("fake_address_real_domain", "fixed", null, 12, fake.length, "Real company domain, invented mailbox.");

    // Same name, two people, two companies.
    const hom = homonymRows.flatMap(([a, b]) => [draftsOfPerson.get(a.id)!, draftsOfPerson.get(b.id)!]);
    for (const d of hom) { d.mess.push("homonym"); d.touched.add("name"); }
    hard.push({ id: "homonyms", kind: "same_name_different_people", description: `${homonymRows.length} pairs of different people with the same name at different companies.`, rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = hom;
    record("homonym", "fixed", null, homonymRows.length * 2, hom.length, "Pairs of different people sharing a full name.");

    const two = drafts.filter((d) => d.mess.includes("same_person_two_companies"));
    hard.push({ id: "same_person_two_companies", kind: "same_person_two_companies", description: `${N_TWO} people registered twice, under two different companies.`, rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = two;
    record("same_person_two_companies", "fixed", null, N_TWO * 2, two.length, "One person, two company names, two rows.");

    // Similar names: some of the smaller company's people type the larger one's exact name.
    const collide: Draft[] = [];
    for (const [A, B] of pairs) {
      const rows = personDrafts().filter((d) => d.company === B && free(d, "company") && d.person!.there);
      const chosen = rows.slice(0, Math.max(1, Math.round(rows.length * 0.3)));
      for (const d of chosen) { d.company_name = A.name; d.mess.push("similar_name_collision"); d.touched.add("company"); collide.push(d); }
    }
    hard.push({ id: "similar_names", kind: "two_companies_similar_names", description: `${pairs.length} pairs of different companies with similar names; some of the smaller company's people typed the larger one's exact name.`, rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = collide;
    record("similar_name_collision", "fixed", null, collide.length, collide.length, "People of the smaller company registered under the larger similar-named company.");

    // Subsidiaries on a parent's domain; some list the parent.
    const subRows = personDrafts().filter((d) => d.company && d.company.parent_id && free(d, "company"));
    const listAsParent = subRows.slice(0, 10);
    for (const d of listAsParent) { d.company_name = byId.get(d.company!.parent_id!)!.name; d.mess.push("subsidiary_listed_as_parent"); d.touched.add("company"); }
    hard.push({ id: "subsidiaries", kind: "subsidiary_on_parent_domain", description: `${subs.length} subsidiaries share their parent's domain, and ${listAsParent.length} of their people list the parent's name.`, rows: [] });
    (hard[hard.length - 1] as HardCase & { _d: Draft[] })._d = subRows;
    record("subsidiary_listed_as_parent", "fixed", null, listAsParent.length, listAsParent.length, "Subsidiary staff who registered under the parent company name.");
    record("subsidiary_on_parent_domain", "fixed", null, subs.length, subs.filter((s) => s.parent_id).length, "Companies whose true domain is their parent's.");
  }

  // Rate-based noise on people.
  const webmailCount = pr(0.06), typoCount = pr(0.015), placeholderCount = pr(0.025);
  const mail = (d: Draft, domain: string) => `${chance(0.5) ? slug(d.first) + "." + slug(d.last) : slug(d.first) + slug(d.last).slice(0, 3) + range(1, 99)}@${domain}`;
  record("placeholder_email_domain", "person_rows", 0.025, placeholderCount, take(placeholderCount, (d) => !!d.company, ["email"], "placeholder_email_domain", (d) => { d.email = chance(0.5) ? `${pick(["info", "test", "a", "none", "x"])}@${pick(PLACEHOLDER_DOMAINS)}` : mail(d, pick(PLACEHOLDER_DOMAINS)); }).length, "Email at test.com, company.com, none.com or asdf.com.");
  record("free_webmail", "person_rows", 0.06, webmailCount, take(webmailCount, (d) => !!d.company, ["email"], "free_webmail", (d) => { d.email = mail(d, pick(WEBMAIL_DOMAINS)); }).length, "A personal webmail address instead of a work address.");
  record("email_typo", "person_rows", 0.015, typoCount, take(typoCount, (d) => !!d.company, ["email"], "email_typo", (d) => { d.email = mail(d, pick(EMAIL_TYPO_DOMAINS)); }).length, "A mistyped mail domain such as gmial.com.");
  const naCount = pr(0.03);
  const naTitle = Math.round(naCount * 0.5), naEmail = Math.round(naCount * 0.3), naCompany = naCount - naTitle - naEmail;
  const NA = ["N/A", "n/a", "-", "--", "NA", "none", ".", "N/A", "-"];
  const naRows = [
    ...take(naTitle, (d) => !!d.company, ["title"], "na_or_dash", (d) => { d.title = pick(NA); }),
    ...take(naEmail, (d) => !!d.company, ["email"], "na_or_dash", (d) => { d.email = pick(NA); }),
    ...take(naCompany, (d) => !!d.company && !d.mess.includes("stale_employer"), ["company"], "na_or_dash", (d) => { d.company_name = pick(NA); }),
  ];
  record("na_or_dash", "person_rows", 0.03, naCount, naRows.length, "N/A or a dash in the title, email or company field.");
  const mashCount = pr(0.01);
  const MASH = ["asdfgh", "qwerty", "xxxxx", "jjjjjj", "zzzz", "lkjhgf", "hhhh", "sdfsdf", "qqqq www", "aaaa"];
  const mashRows = [
    ...take(Math.round(mashCount * 0.6), (d) => !!d.company && !d.mess.includes("stale_employer"), ["company"], "keyboard_mash", (d) => { d.company_name = pick(MASH); }),
    ...take(mashCount - Math.round(mashCount * 0.6), (d) => !!d.company, ["name"], "keyboard_mash", (d) => { d.first = pick(["asdf", "qwe", "xxx", "jkl"]); d.last = pick(["sdfg", "wer", "xxx", "jkl;"]); d.badge = d.first; }),
  ];
  record("keyboard_mash", "person_rows", 0.01, mashCount, mashRows.length, "Keyboard mashing in the company or name fields.");
  const swapCT = pr(0.01), swapFL = pr(0.015), ownName = pr(0.01);
  record("swapped_company_title", "person_rows", 0.01, swapCT, take(swapCT, (d) => !!d.company && !d.mess.includes("stale_employer"), ["company", "title"], "swapped_company_title", (d) => { [d.company_name, d.title] = [d.title, d.company_name]; }).length, "Company in the title column and title in the company column.");
  record("swapped_first_last", "person_rows", 0.015, swapFL, take(swapFL, (d) => !!d.company, ["name"], "swapped_first_last", (d) => { [d.first, d.last] = [d.last, d.first]; }).length, "First and last name in each other's columns.");
  record("person_name_as_company", "person_rows", 0.01, ownName, take(ownName, (d) => !!d.company && !d.mess.includes("stale_employer"), ["company"], "person_name_as_company", (d) => { d.company_name = chance(0.5) ? `${d.first} ${d.last}` : `${d.last}, ${d.first}`; }).length, "The person's own name in the company field.");

  // Spellings of the company: casing and legal suffixes fold together; typos and short forms do not.
  const SUFFIX: Record<string, string[]> = { Germany: ["GmbH", "AG"], Spain: ["S.A.", "S.L."], Mexico: ["S.A.", "SRL"], "Dominican Republic": ["S.A.", "SRL", "SAS"], Colombia: ["S.A.S.", "SAS"], Argentina: ["S.A."], France: ["SAS", "SARL"], Brazil: ["Ltda"], Portugal: ["Lda", "SA"], Italy: ["S.p.A.", "SRL"], "United Kingdom": ["Ltd", "Limited", "PLC"], "United States": ["Inc.", "LLC", "Corp"], Ireland: ["Ltd"], Sweden: ["AB"], Denmark: ["A/S", "ApS"], Poland: ["S.A."], India: ["Ltd", "Pvt Ltd"], Nigeria: ["Ltd"], Turkey: ["A.S."], Japan: ["Co., Ltd."], "South Korea": ["Co., Ltd."], Ghana: ["Ltd"], "United Arab Emirates": ["LLC"], Czechia: ["a.s."] };
  const foldable = new Set(["inc", "llc", "ltd", "corp", "gmbh", "sa", "sas", "sarl", "srl", "ltda", "plc", "ag", "ab", "spa", "co", "limited"]);
  const variant = (d: Draft) => {
    const name = d.company_name;
    const r = rand();
    if (r < 0.28) return name.toUpperCase();
    if (r < 0.4) return name.toLowerCase();
    const suf = (SUFFIX[d.company!.country] ?? ["Inc"]).filter((s) => foldable.has(companyKey(`x ${s}`).split(" ").pop()!));
    if (!suf.length || r < 0.52) return name.toUpperCase().replace(/ /g, "  ");
    const s = pick(suf);
    return r < 0.8 ? `${name} ${s}` : `${name}, ${s}`;
  };
  const variantRows = personDrafts().concat(drafts.filter((d) => d.kind === "company_only"));
  const variantCount = pr(0.22);
  const variantChosen = take(variantCount, (d) => !!d.company && d.company.list_status === null, ["company"], "name_variant", (d) => { d.company_name = variant(d); }, variantRows);
  // The seller's two lists get their variants too.
  for (const d of drafts) if (d.company && d.company.list_status && free(d, "company") && chance(0.5)) { d.company_name = variant(d); d.mess.push("name_variant"); d.touched.add("company"); }
  record("name_variant", "person_rows", 0.22, variantCount, drafts.filter((d) => d.mess.includes("name_variant")).length, "Same company, different casing, spacing or legal suffix. Folds to one company in the upload.");
  const typoShort = pr(0.04);
  const mangle = (d: Draft) => {
    const full = d.company!.name;
    const r = rand();
    let out: string;
    const words = full.split(" ");
    if (r < 0.5 && full.length > 6) { const i = 1 + int(full.length - 3); out = full.slice(0, i) + full[i + 1] + full[i] + full.slice(i + 2); }
    else if (words.length > 1) out = words[0];
    else out = full.slice(0, -1);
    if (companyKey(out) === companyKey(full) || usedKeys.has(companyKey(out))) out = full.slice(0, -1);
    return out;
  };
  const mangled = take(typoShort, (d) => !!d.company && d.company.list_status === null && !d.mess.includes("stale_employer"), ["company"], "name_typo_or_short", (d) => { const o = mangle(d); d.company_name = o; if (!usedKeys.has(companyKey(o)) && companyKey(o) !== d.company!.id) d.company!.aliases.push(o); });
  record("name_typo_or_short", "person_rows", 0.04, typoShort, mangled.length, "A typo or a shortened name. Does not fold to the right company in the upload, a vendor search still finds it.");

  // Email blank, then the website field.
  const emailBlank = pr(0.12);
  record("email_blank", "person_rows", 0.12, emailBlank, take(emailBlank, (d) => !!d.company, ["email"], "email_blank", (d) => { d.email = ""; }).length, "No email given.");
  const websiteBlank = Math.round(0.14 * N), websiteFiller = Math.round(0.11 * N);
  const FILLER = ["N/A", "n/a", "-", "none", "www", "http://", "tbd", "TBC", ".com", "no website", "test.com", "company.com", "none.com", "asdf.com", "www.test.com", "http://www.company.com"];
  for (const d of drafts) if (d.mess.includes("keyboard_mash") || d.mess.includes("non_company")) { d.website = ""; d.touched.add("website"); }
  const forced = drafts.filter((d) => d.touched.has("website") && d.website === "");
  forced.forEach((d) => d.mess.push("website_blank"));
  const wb = take(websiteBlank - forced.length, () => true, ["website"], "website_blank", (d) => { d.website = ""; }, drafts);
  const wf = take(websiteFiller, () => true, ["website"], "website_filler", (d) => { d.website = pick(FILLER); }, drafts);
  record("website_blank", "rows", 0.14, websiteBlank, forced.length + wb.length, "Website field left empty.");
  record("website_filler", "rows", 0.11, websiteFiller, wf.length, "Website field holds filler: N/A, a dash, www, or a placeholder domain.");
  // Real duplicates: the same person registered twice, copied from clean rows.
  const cleanSrc = shuffle(drafts.filter((d) => d.kind === "person" && d.person && d.person.kind === "employee" && d.person.there && d.company_name === d.company!.name && ![...d.mess].some((m) => !["name_variant", "website_blank", "website_filler"].includes(m) && m !== "email_blank") && d.email.includes("@")));
  const dups: Draft[] = [];
  for (let i = 0; i < N_DUP; i++) {
    const s = cleanSrc[i];
    const d = { ...s, mess: ["duplicate"], touched: new Set(["company", "name", "title", "email"]) } as Draft;
    const r = rand();
    if (r < 0.35) { /* an exact repeat */ }
    else if (r < 0.6) d.email = "";
    else if (r < 0.8) d.company_name = s.company_name.toUpperCase();
    else d.title = s.title.toLowerCase();
    d.ticket = s.ticket; d.diet = s.diet;
    dups.push(d);
  }
  drafts.push(...dups);
  record("duplicate", "person_rows", 0.03, N_DUP, dups.length, "The same person registered twice, sometimes with a field changed.");
  for (const d of dups) { d.mess.push(...[]); }
  // The non-company people are a mess type in their own right.
  record("non_company", "person_rows", 0.03, N_NON, drafts.filter((d) => d.mess.includes("non_company")).length, "Students, press and the self-employed: 17 students, 11 press, the rest self-employed.");
  record("stale_employer", "person_rows", 0.04, Math.round(0.04 * PERSON_ROWS), drafts.filter((d) => d.mess.includes("stale_employer")).length, "Registered under an old employer.");
  record("company_only", "rows", 0.15, C_ONLY, drafts.filter((d) => d.kind === "company_only").length, "Rows with a company and no person.");

  // Fill the website for every row left untouched with the true site (already set). Then order by registration.
  const ordered = shuffle(drafts);
  // Delegations register in bursts: sort loosely by company, then interleave.
  const keyed = ordered.map((d, i) => ({ d, k: (d.company ? Number(d.company.id.slice(2)) : 999) * 0.18 + i * 0.97 + rand() * 40 }));
  keyed.sort((a, b) => a.k - b.k);
  const rowsOut = keyed.map((x) => x.d);
  const rows: WorldRow[] = rowsOut.map((d, i) => ({ row: i + 1, person_id: d.person?.id ?? null, company_id: d.company?.id ?? null, mess: [...new Set(d.mess)].sort() }));
  const rowIndex = new Map(rowsOut.map((d, i) => [d, i + 1]));
  for (const h of hard) { const dd = (h as HardCase & { _d?: Draft[] })._d ?? []; h.rows = dd.map((d) => rowIndex.get(d)!).filter(Boolean).sort((a, b) => a - b); delete (h as HardCase & { _d?: Draft[] })._d; }

  /* ---- csv ---- */
  const HEAD = ["Registration ID", "Registered On", "Ticket Type", "First Name", "Last Name", "Badge Name", "Company Name", "Job Title", "Work Email", "Website", "Country", "LinkedIn URL", "Dietary Needs", "Accessibility Needs", "Notes"];
  const day0 = Date.UTC(2026, 8, 14);
  const records = rowsOut.map((d, i) => [
    `MTE27-${String(i + 1).padStart(5, "0")}`, new Date(day0 + Math.floor((i / rowsOut.length) * 54 * 86400000) + int(80000) * 1000).toISOString().slice(0, 10),
    d.ticket, d.first, d.last, d.badge, d.company_name, d.title, d.email, d.website, d.country, d.linkedin, d.diet, d.access, d.notes,
  ]);
  const lead = [["Meridian Trade Expo 2027: registration export", ...Array(HEAD.length - 1).fill("")], [`Exported 2026-11-02 from the registration desk. ${rowsOut.length} registrations, all ticket types.`, ...Array(HEAD.length - 1).fill("")]];
  const csv = Papa.unparse([...lead, HEAD, ...records], { newline: "\n" }) + "\n";

  /* ---- world ---- */
  const junkKeys = new Set<string>();
  for (const d of rowsOut) {
    const k = companyKey(d.company_name);
    const mess = d.mess;
    if (mess.includes("keyboard_mash") && MASH.includes(d.company_name)) junkKeys.add(k);
    if (mess.includes("na_or_dash") && NA.includes(d.company_name)) junkKeys.add(k);
    if (mess.includes("non_company")) junkKeys.add(k);
    if (mess.includes("person_name_as_company")) junkKeys.add(k);
    if (mess.includes("swapped_company_title")) junkKeys.add(k);
  }
  for (const c of companies) junkKeys.delete(companyKey(c.name));
  const rowsPerCompany = new Map<string, number>();
  for (const r of rows) if (r.company_id) rowsPerCompany.set(r.company_id, (rowsPerCompany.get(r.company_id) ?? 0) + 1);
  const sizes = [...rowsPerCompany.values()].sort((a, b) => b - a);
  const meta: World["meta"] = {
    seed,
    event: { name: "Meridian Trade Expo", venue: "Meridian Exhibition Centre, Valencia", starts_on: "2027-03-30" },
    seller: SELLER,
    rows: rows.length, person_rows: rows.filter((r) => r.person_id).length, company_only_rows: rows.filter((r) => !r.person_id).length,
    companies: companies.length, people: people.length,
    mess: stats,
    shared_mailboxes: [...new Set(drafts.filter((d) => d.mess.includes("shared_team_email")).map((d) => d.email))].sort(),
    placeholder_domains: PLACEHOLDER_DOMAINS, webmail_domains: [...WEBMAIL_DOMAINS, ...EMAIL_TYPO_DOMAINS],
    extra_domains: [AGENCY_DOMAIN, ...new Set(nonCompany.filter((p) => p.kind === "student").map((p) => p.email.split("@")[1]))],
    delegation_sizes: { top: sizes.slice(0, 10), rows_per_company_median: sizes[Math.floor(sizes.length / 2)], companies_with_one_or_two_people: [...attendCount.values()].filter((n) => n <= 2).length },
  };
  const world: World = { meta, companies, people, rows, titles, junk_company_keys: [...junkKeys].sort(), hard_cases: hard };
  return { world, csv };
}

/** One record per line, so a diff of the file shows which company or person changed. */
export function serialize(w: World) {
  const lines = <X>(xs: X[]) => `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]`;
  return `{\n"meta": ${JSON.stringify(w.meta, null, 1)},\n"companies": ${lines(w.companies)},\n"people": ${lines(w.people)},\n"rows": ${lines(w.rows)},\n"titles": ${JSON.stringify(w.titles)},\n"junk_company_keys": ${JSON.stringify(w.junk_company_keys)},\n"hard_cases": ${lines(w.hard_cases)}\n}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv[2] ?? "samples";
  mkdirSync(out, { recursive: true });
  const { world, csv } = buildWorld();
  writeFileSync(`${out}/world.json`, serialize(world));
  writeFileSync(`${out}/attendees-large.csv`, csv);
  const m = world.meta;
  console.log(`rows ${m.rows} (people ${m.person_rows}, company-only ${m.company_only_rows}), companies ${m.companies}, people in world ${m.people}`);
  for (const s of m.mess) console.log(`  ${s.tag.padEnd(30)} target ${String(s.target).padStart(4)}  actual ${String(s.actual).padStart(4)}`);
}
