// src/lib/pricing.ts
var FREE_SHIPPING_THRESHOLD = 15e3;
var DELIVERY_OPTIONS = [
  {
    id: "standard",
    name: "Standard delivery",
    eta: "2\u20134 working days",
    price: 495,
    description: "Tracked Royal Mail 24 \xB7 free on orders over \xA3150"
  },
  {
    id: "express",
    name: "Express delivery",
    eta: "Next working day",
    price: 995,
    description: "Order before 2pm \xB7 tracked and signed for"
  },
  {
    id: "saturday",
    name: "Saturday delivery",
    eta: "Saturday by 1pm",
    price: 1495,
    description: "Order before 2pm Friday \xB7 tracked and signed for"
  }
];
function getDeliveryOption(id) {
  return DELIVERY_OPTIONS.find((option) => option.id === id) ?? DELIVERY_OPTIONS[0];
}
var PROMOS = [
  {
    code: "WELCOME10",
    kind: "percent",
    value: 10,
    minSpend: 5e3,
    description: "10% off your first order"
  },
  {
    code: "HALCYON20",
    kind: "percent",
    value: 20,
    minSpend: 3e4,
    description: "20% off orders over \xA3300"
  },
  {
    code: "FREESHIP",
    kind: "shipping",
    value: 0,
    minSpend: 0,
    description: "Complimentary delivery"
  }
];
function findPromo(rawCode) {
  if (!rawCode) return void 0;
  const code = rawCode.trim().toUpperCase();
  return PROMOS.find((promo) => promo.code === code);
}
function lineKey(line) {
  return `${line.productId}::${line.size}::${line.colour}`;
}
function resolveLines(lines, products) {
  const byId = new Map(products.map((product) => [product.id, product]));
  return lines.flatMap((line) => {
    const product = byId.get(line.productId);
    if (!product) return [];
    const size = product.sizes.includes(line.size) ? line.size : product.sizes[0];
    const colour = product.colours.some((c) => c.name === line.colour) ? line.colour : product.colours[0].name;
    const qty = Math.min(Math.max(1, Math.round(line.qty) || 1), 10);
    return [
      {
        ...line,
        size,
        colour,
        qty,
        key: lineKey({ ...line, size, colour }),
        product,
        lineTotal: product.price * qty
      }
    ];
  });
}
function computeTotals(subtotal, deliveryId, promoCode) {
  const delivery = getDeliveryOption(deliveryId);
  const promo = findPromo(promoCode);
  const promoApplies = promo ? subtotal >= promo.minSpend : false;
  let discount = 0;
  if (promo && promoApplies) {
    if (promo.kind === "percent") discount = Math.round(subtotal * promo.value / 100);
    if (promo.kind === "fixed") discount = Math.min(promo.value, subtotal);
  }
  const discountedSubtotal = subtotal - discount;
  let deliveryPrice = delivery.price;
  if (deliveryId === void 0 || delivery.id === "standard") {
    deliveryPrice = discountedSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : delivery.price;
  }
  if (promo && promoApplies && promo.kind === "shipping") deliveryPrice = 0;
  return {
    subtotal,
    discount,
    delivery: deliveryPrice,
    total: Math.max(0, discountedSubtotal + deliveryPrice),
    freeShippingRemaining: Math.max(0, FREE_SHIPPING_THRESHOLD - discountedSubtotal),
    promo: promoApplies ? promo : void 0
  };
}

// src/server/http.ts
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}
function badRequest(message, status = 400) {
  return json({ error: message }, status);
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
function siteOrigin(request, siteUrl) {
  const configured = siteUrl?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return new URL(request.url).origin;
}
function absoluteUrl(origin, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

// src/server/auth.ts
var COOKIE_NAME = "halcyon_admin";
var SESSION_TTL_SECONDS = 60 * 60 * 8;
var encoder = new TextEncoder();
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function constantTimeEqual(a, b) {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let mismatch = 0;
  for (let index = 0; index < bytesA.length; index += 1) {
    mismatch |= bytesA[index] ^ bytesB[index];
  }
  return mismatch === 0;
}
function sessionSecret(env) {
  const secret = env.ADMIN_SESSION_SECRET?.trim() || env.ADMIN_PASSWORD?.trim() || "";
  return `halcyon-admin-session:${secret}`;
}
async function passwordMatches(input, expected) {
  if (!expected) return false;
  return constantTimeEqual(input, expected);
}
async function createSessionToken(secret) {
  const expires = Math.floor(Date.now() / 1e3) + SESSION_TTL_SECONDS;
  const signature = await hmac(secret, `admin:${expires}`);
  return `${expires}.${signature}`;
}
async function verifySessionToken(token, secret) {
  if (!token) return false;
  const [rawExpiry, signature, extra] = token.split(".");
  if (extra !== undefined || !/^\d+$/.test(rawExpiry)) return false;
  const expires = Number(rawExpiry);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1e3)) return false;
  if (!signature) return false;
  const expected = await hmac(secret, `admin:${expires}`);
  return constantTimeEqual(signature, expected);
}
function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get("cookie");
  if (!header) return void 0;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); }
      catch { return undefined; }
    }
  }
  return void 0;
}
function sessionCookie(token, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function clientAddress(request) {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
var ADMIN_COOKIE_NAME = COOKIE_NAME;

// src/lib/products.ts
var CLOTHING_SIZES = ["XS", "S", "M", "L", "XL"];
var SHOE_SIZES = ["UK 5", "UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"];
var ONE_SIZE = ["One size"];
var CATEGORIES = [
  {
    id: "clothing",
    name: "Clothing",
    blurb: "Coats, knitwear and tailoring in natural fibres.",
    image: "/images/products/ashcombe-overcoat.jpg",
    meta: "4 pieces"
  },
  {
    id: "shoes",
    name: "Shoes",
    blurb: "Hand-finished boots, loafers and everyday sneakers.",
    image: "/images/products/fitzroy-chelsea-boots.jpg",
    meta: "4 pieces"
  },
  {
    id: "bags",
    name: "Bags",
    blurb: "Structured leather and woven raffia, made in small runs.",
    image: "/images/products/kenwood-tote.jpg",
    meta: "4 pieces"
  },
  {
    id: "watches",
    name: "Watches",
    blurb: "Swiss movements, quiet dials, honest materials.",
    image: "/images/products/meridian-automatic.jpg",
    meta: "4 pieces"
  }
];
var SEED_BASE = [
  {
    id: "cl-overcoat",
    slug: "ashcombe-cashmere-overcoat",
    name: "Ashcombe Cashmere Overcoat",
    category: "clothing",
    price: 49500,
    shortDescription: "A double-breasted overcoat in a wool and cashmere melton.",
    description: "The Ashcombe is cut in a soft wool-cashmere melton woven in Yorkshire, with a relaxed shoulder and a clean double-breasted line. It falls just below the knee, takes a scarf without bulk, and is fully lined in cupro so it slips over knitwear. A coat intended to be worn for a decade, not a season.",
    material: "80% wool, 20% cashmere \xB7 cupro lining",
    details: [
      "Regular fit, falls below the knee",
      "Double-breasted with horn buttons",
      "Two welt pockets and one interior pocket",
      "Made in Portugal",
      "Dry clean only"
    ],
    colours: [
      { name: "Camel", hex: "#b58a5e" },
      { name: "Charcoal", hex: "#3f3f40" },
      { name: "Navy", hex: "#232b3a" }
    ],
    sizes: CLOTHING_SIZES,
    image: "/images/products/ashcombe-overcoat.jpg",
    rating: 4.8,
    reviewCount: 214,
    badge: "Bestseller",
    stock: 24,
    collection: ["New in", "The coat edit"]
  },
  {
    id: "cl-rollneck",
    slug: "halden-merino-roll-neck",
    name: "Halden Merino Roll-Neck",
    category: "clothing",
    price: 12e3,
    shortDescription: "Fine-gauge extra-fine merino, knitted in Scotland.",
    description: "Knitted from extra-fine merino with a light, even hand, the Halden is the layer we reach for from October to March. The roll-neck sits close without pressure, and the body is long enough to tuck. It holds its shape through a winter of wear and softens with every wash.",
    material: "100% extra-fine merino wool",
    details: [
      "Slim regular fit",
      "Ribbed cuffs, hem and roll-neck",
      "Fully fashioned, knitted in Scotland",
      "Hand wash cool or wool cycle"
    ],
    colours: [
      { name: "Ivory", hex: "#efe7d8" },
      { name: "Ink", hex: "#1b1a19" },
      { name: "Moss", hex: "#5a6048" }
    ],
    sizes: CLOTHING_SIZES,
    image: "/images/products/halden-roll-neck.jpg",
    rating: 4.7,
    reviewCount: 168,
    stock: 60,
    collection: ["New in", "Knitwear"]
  },
  {
    id: "cl-slipdress",
    slug: "seraphine-silk-slip-dress",
    name: "Seraphine Silk Slip Dress",
    category: "clothing",
    price: 24500,
    shortDescription: "Bias-cut sandwashed silk with adjustable straps.",
    description: "Cut on the bias so it moves rather than clings, the Seraphine is made from sandwashed silk with a matte, fluid finish. Wear it alone in September or under a heavy knit in December. The straps are adjustable and the hem is finished by hand.",
    material: "100% sandwashed mulberry silk",
    details: [
      "Bias cut, midi length",
      "Adjustable straps",
      "French seams throughout",
      "Made in Italy",
      "Dry clean or hand wash cold"
    ],
    colours: [
      { name: "Oxblood", hex: "#5e2130" },
      { name: "Black", hex: "#151515" },
      { name: "Champagne", hex: "#d8c7a8" }
    ],
    sizes: CLOTHING_SIZES,
    image: "/images/products/seraphine-slip-dress.jpg",
    rating: 4.6,
    reviewCount: 92,
    badge: "New in",
    stock: 18,
    collection: ["New in", "Evening"]
  },
  {
    id: "cl-trousers",
    slug: "marchmont-wool-trousers",
    name: "Marchmont Wool Trousers",
    category: "clothing",
    price: 16500,
    compareAt: 21e3,
    shortDescription: "Pleated Italian wool trousers with a tapered leg.",
    description: "A single-pleat trouser in a mid-weight Italian wool that presses beautifully and resists creasing on a long day. Cut with a high waist, a clean taper and an unfinished hem so they can be altered to your exact break.",
    material: "98% virgin wool, 2% elastane",
    details: [
      "High rise, tapered leg",
      "Single forward pleat",
      "Unfinished hem for tailoring",
      "Made in Italy"
    ],
    colours: [
      { name: "Charcoal", hex: "#43423f" },
      { name: "Stone", hex: "#a89c88" }
    ],
    sizes: CLOTHING_SIZES,
    image: "/images/products/marchmont-trousers.jpg",
    rating: 4.5,
    reviewCount: 76,
    stock: 30,
    collection: ["Tailoring", "Last chance"]
  },
  {
    id: "sh-chelsea",
    slug: "fitzroy-leather-chelsea-boots",
    name: "Fitzroy Leather Chelsea Boots",
    category: "shoes",
    price: 28500,
    shortDescription: "Goodyear-welted Chelsea boots in polished calf leather.",
    description: "Built on a slightly rounded last and Goodyear-welted so they can be resoled for years, the Fitzroy is made from full-grain calf leather with twin elastic gores and a leather pull tab. They take a shine, hold their shape and only get better with wear.",
    material: "Full-grain calf leather \xB7 leather sole",
    details: [
      "Goodyear-welted construction",
      "Calf leather lining and insole",
      "Stacked leather heel with rubber top piece",
      "Made in Northamptonshire, England"
    ],
    colours: [
      { name: "Black", hex: "#171717" },
      { name: "Dark brown", hex: "#3b2a20" }
    ],
    sizes: SHOE_SIZES,
    image: "/images/products/fitzroy-chelsea-boots.jpg",
    rating: 4.9,
    reviewCount: 301,
    badge: "Bestseller",
    stock: 22,
    collection: ["Footwear", "The everyday edit"]
  },
  {
    id: "sh-loafer",
    slug: "sloane-suede-loafers",
    name: "Sloane Suede Loafers",
    category: "shoes",
    price: 21500,
    shortDescription: "Unlined suede penny loafers with a flexible sole.",
    description: "An unlined loafer in soft Italian suede, made on a low-profile last with a hand-stitched apron. Light enough to wear without socks in summer, structured enough for tailoring the rest of the year.",
    material: "Italian suede \xB7 leather lining",
    details: [
      "Unlined upper for a soft, immediate fit",
      "Blake-stitched flexible sole",
      "Leather-lined footbed",
      "Made in Portugal"
    ],
    colours: [
      { name: "Tan", hex: "#a97b4e" },
      { name: "Chocolate", hex: "#4a3427" },
      { name: "Slate", hex: "#5b6167" }
    ],
    sizes: SHOE_SIZES,
    image: "/images/products/sloane-loafers.jpg",
    rating: 4.6,
    reviewCount: 128,
    stock: 34,
    collection: ["Footwear", "New in"]
  },
  {
    id: "sh-sneaker",
    slug: "ellis-leather-sneakers",
    name: "Ellis Leather Sneakers",
    category: "shoes",
    price: 15e3,
    shortDescription: "Minimal Italian leather sneakers with a cream sole.",
    description: "The Ellis strips the sneaker back to what matters: clean lines, full-grain leather and a sole that quietly grips. There is no visible branding, which is rather the point. Wear them with everything, replace the laces, keep them for years.",
    material: "Full-grain leather \xB7 natural rubber sole",
    details: [
      "Hand-finished leather upper",
      "Removable cushioned insole",
      "Margom-style rubber cupsole",
      "Made in Italy",
      "Includes spare waxed cotton laces"
    ],
    colours: [
      { name: "White", hex: "#f2efe9" },
      { name: "Black", hex: "#1a1a1a" }
    ],
    sizes: SHOE_SIZES,
    image: "/images/products/ellis-sneakers.jpg",
    rating: 4.7,
    reviewCount: 486,
    badge: "Bestseller",
    stock: 48,
    collection: ["Footwear", "The everyday edit"]
  },
  {
    id: "sh-ankleboot",
    slug: "aurelia-heeled-ankle-boots",
    name: "Aurelia Heeled Ankle Boots",
    category: "shoes",
    price: 26500,
    compareAt: 32e3,
    shortDescription: "Chocolate leather ankle boots on a 60mm block heel.",
    description: "A boot you can walk in: a 60mm block heel, a softly squared toe and a padded collar. Made in smooth chocolate calf leather with a side zip and a leather sole with a rubber insert for grip on wet pavements.",
    material: "Calf leather \xB7 leather sole with rubber insert",
    details: [
      "60mm covered block heel",
      "Inside zip with leather pull",
      "Padded ankle collar",
      "Made in Spain"
    ],
    colours: [
      { name: "Chocolate", hex: "#40291d" },
      { name: "Black", hex: "#141414" }
    ],
    sizes: SHOE_SIZES,
    image: "/images/products/aurelia-ankle-boots.jpg",
    rating: 4.4,
    reviewCount: 63,
    badge: "Last few",
    stock: 9,
    collection: ["Footwear", "Last chance"]
  },
  {
    id: "bg-tote",
    slug: "kenwood-structured-tote",
    name: "Kenwood Structured Tote",
    category: "bags",
    price: 38500,
    shortDescription: "A structured tote in vegetable-tanned calf leather.",
    description: "Designed for a laptop, a notebook and the rest of a working day, the Kenwood holds its shape thanks to a reinforced base and a rigid top edge. Vegetable-tanned leather from a Tuscan tannery that patinas rather than wears out.",
    material: "Vegetable-tanned calf leather \xB7 cotton canvas lining",
    details: [
      "Fits a 14-inch laptop",
      "Magnetic closure and interior zip pocket",
      "Two slip pockets for phone and cards",
      "Hand-finished edges, made in Italy",
      "Protective cotton dust bag included"
    ],
    colours: [
      { name: "Tan", hex: "#b5895c" },
      { name: "Black", hex: "#191919" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/kenwood-tote.jpg",
    rating: 4.8,
    reviewCount: 142,
    stock: 16,
    collection: ["Bags", "The everyday edit"]
  },
  {
    id: "bg-crossbody",
    slug: "noir-quilted-crossbody",
    name: "Noir Quilted Crossbody",
    category: "bags",
    price: 29500,
    shortDescription: "Diamond-quilted lambskin on a fine gold chain.",
    description: "A compact evening bag in diamond-quilted lambskin with an antiqued brass chain that can be doubled to sit on the shoulder. Inside: a card slot, a mirror and just enough room for a phone, lipstick and keys.",
    material: "Quilted lambskin \xB7 antiqued brass hardware",
    details: [
      "Diamond quilting, hand-finished edges",
      "Convertible chain strap, 55cm drop",
      "Interior card slot and mirror",
      "Made in Italy"
    ],
    colours: [
      { name: "Black", hex: "#151515" },
      { name: "Bordeaux", hex: "#57202a" },
      { name: "Cream", hex: "#e6ddcd" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/noir-crossbody.jpg",
    rating: 4.7,
    reviewCount: 208,
    badge: "Bestseller",
    stock: 27,
    collection: ["Bags", "Evening"]
  },
  {
    id: "bg-basket",
    slug: "palmier-woven-basket-bag",
    name: "Palmier Woven Basket Bag",
    category: "bags",
    price: 18e3,
    shortDescription: "Hand-woven raffia with tan leather handles.",
    description: "Woven by hand from natural raffia, with saddle-leather handles that darken in the sun. Roomy enough for a towel and a paperback, structured enough to stand on its own. A summer bag that is not a novelty.",
    material: "Natural raffia \xB7 vegetable-tanned leather handles",
    details: [
      "Hand-woven in Madagascar",
      "Removable leather drawstring pouch",
      "Unlined to keep it light",
      "Approx. 32 \xD7 26 \xD7 14cm"
    ],
    colours: [
      { name: "Natural", hex: "#d5c19d" },
      { name: "Noir", hex: "#2b2723" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/palmier-basket-bag.jpg",
    rating: 4.5,
    reviewCount: 54,
    badge: "New in",
    stock: 21,
    collection: ["Bags", "New in"]
  },
  {
    id: "bg-weekender",
    slug: "voyager-leather-weekender",
    name: "Voyager Leather Weekender",
    category: "bags",
    price: 46500,
    shortDescription: "A cabin-sized holdall in full-grain bridle leather.",
    description: "Built for two nights away: a 40-litre holdall in thick bridle leather with solid brass hardware, a suede-lined base and a detachable webbing shoulder strap. It softens into shape after a few trips and will outlast most of what you pack in it.",
    material: "Full-grain bridle leather \xB7 suede base \xB7 solid brass",
    details: [
      "Cabin friendly, approx. 40L",
      "Detachable padded shoulder strap",
      "Two internal pockets, one zip",
      "Solid brass feet on the base",
      "Made in England, limited run of 120"
    ],
    colours: [
      { name: "Dark brown", hex: "#3a2a1e" },
      { name: "Conker", hex: "#5a2c1d" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/voyager-weekender.jpg",
    rating: 4.9,
    reviewCount: 38,
    badge: "Last few",
    stock: 6,
    collection: ["Bags", "Travel"]
  },
  {
    id: "wt-meridian",
    slug: "meridian-automatic-38",
    name: "Meridian Automatic 38",
    category: "watches",
    price: 72e3,
    shortDescription: "A 38mm steel automatic with a silver opaline dial.",
    description: "A quietly proportioned 38mm steel watch with a Swiss automatic movement, a brushed and polished case and a silver opaline dial with applied baton indices. Sapphire crystal front and back, 100m water resistance, and a bracelet with a quick-release spring bar so you can swap it for leather.",
    material: "316L stainless steel \xB7 sapphire crystal",
    details: [
      "Swiss automatic movement, 38-hour power reserve",
      "38mm case, 10.2mm thick, 20mm lugs",
      "Sapphire crystal with anti-reflective coating",
      "100m water resistance",
      "Two-year movement warranty"
    ],
    colours: [
      { name: "Steel / silver", hex: "#c9c9c7" },
      { name: "Steel / slate", hex: "#5c6570" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/meridian-automatic.jpg",
    rating: 4.8,
    reviewCount: 97,
    badge: "Bestseller",
    stock: 12,
    collection: ["Watches", "The everyday edit"]
  },
  {
    id: "wt-regent",
    slug: "regent-dress-watch",
    name: "Regent Dress Watch",
    category: "watches",
    price: 54e3,
    shortDescription: "A gold-tone dress watch with a cream lacquer dial.",
    description: "A 36mm dress watch with a cream lacquer dial, slim leaf hands and a brown alligator strap. The case is gold PVD over steel at 6.8mm thick, so it disappears under a shirt cuff. Hand-wound, because winding a watch is a small pleasure.",
    material: "Gold PVD steel \xB7 alligator strap \xB7 sapphire crystal",
    details: [
      "Swiss hand-wound movement",
      "36mm case, 6.8mm thick",
      "Cream lacquer dial, gold leaf hands",
      "Genuine alligator strap with pin buckle",
      "Two-year movement warranty"
    ],
    colours: [
      { name: "Gold / cream", hex: "#d9b877" },
      { name: "Steel / white", hex: "#dcdcdc" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/regent-dress-watch.jpg",
    rating: 4.6,
    reviewCount: 41,
    stock: 14,
    collection: ["Watches", "Evening"]
  },
  {
    id: "wt-chronograph",
    slug: "chronograph-no-4",
    name: "Chronograph No.4",
    category: "watches",
    price: 68e3,
    shortDescription: "A matte black chronograph on a steel case.",
    description: "Our take on the working chronograph: a matte black dial with three subdials, a tachymeter bezel and a 40mm steel case. The movement is a Swiss quartz chronograph, chosen for accuracy and low maintenance \u2014 this is a watch to wear, not to baby.",
    material: "316L stainless steel \xB7 sapphire crystal \xB7 calf strap",
    details: [
      "Swiss quartz chronograph movement",
      "40mm case, 12mm thick",
      "30-minute and 12-hour counters, running seconds",
      "100m water resistance",
      "Two-year warranty"
    ],
    colours: [
      { name: "Black dial", hex: "#1c1c1c" },
      { name: "Panda", hex: "#e8e4dc" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/chronograph-no4.jpg",
    rating: 4.7,
    reviewCount: 72,
    stock: 19,
    collection: ["Watches", "New in"]
  },
  {
    id: "wt-otford",
    slug: "otford-slim-36",
    name: "Otford Slim 36",
    category: "watches",
    price: 39500,
    compareAt: 45e3,
    shortDescription: "A 36mm minimalist watch on a tan leather strap.",
    description: "The Otford is as simple as a watch can be: a 36mm case, a white dial, thin gold hands and no date window. Quartz, 5mm thick, on a tan vegetable-tanned leather strap. The sort of watch that goes with a t-shirt and with a suit.",
    material: "Gold PVD steel \xB7 sapphire crystal \xB7 leather strap",
    details: [
      "Swiss quartz movement",
      "36mm case, 5mm thick",
      "Vegetable-tanned leather strap, quick release",
      "50m water resistance",
      "Two-year warranty"
    ],
    colours: [
      { name: "Gold / tan", hex: "#c9a869" },
      { name: "Steel / black", hex: "#333333" }
    ],
    sizes: ONE_SIZE,
    image: "/images/products/otford-slim.jpg",
    rating: 4.5,
    reviewCount: 118,
    stock: 25,
    collection: ["Watches", "Last chance"]
  }
];
var SEED_PRODUCTS = SEED_BASE.map((product, index) => {
  const created = new Date(Date.UTC(2026, 6, 6 + index, 9, 0, 0)).toISOString();
  return { ...product, status: "active", createdAt: created, updatedAt: created };
});

// src/server/store.ts
var ONE_SIZE_CATEGORIES = /* @__PURE__ */ new Set(["bags", "watches"]);
function normaliseProduct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw;
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;
  const category = CATEGORIES.some((entry) => entry.id === value.category) ? value.category : "clothing";
  const colours = Array.isArray(value.colours) ? value.colours.filter((colour) => {
    if (!colour || typeof colour !== "object") return false;
    const entry = colour;
    return typeof entry.name === "string" && typeof entry.hex === "string";
  }).map((colour) => ({ name: colour.name, hex: colour.hex })) : [];
  const sizes = Array.isArray(value.sizes) ? value.sizes.map(String).filter(Boolean) : [];
  const collection = Array.isArray(value.collection) ? value.collection.map(String) : [];
  const details = Array.isArray(value.details) ? value.details.map(String) : [];
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : value.id,
    name: value.name,
    category,
    price: Math.max(0, Math.round(Number(value.price) || 0)),
    compareAt: Number.isFinite(Number(value.compareAt)) && Number(value.compareAt) > 0 ? Math.round(Number(value.compareAt)) : void 0,
    shortDescription: typeof value.shortDescription === "string" ? value.shortDescription : "",
    description: typeof value.description === "string" ? value.description : "",
    material: typeof value.material === "string" ? value.material : "",
    details,
    colours: colours.length > 0 ? colours : [{ name: "Natural", hex: "#d8cdb9" }],
    sizes: sizes.length > 0 ? sizes : ONE_SIZE_CATEGORIES.has(category) ? ["One size"] : ["S", "M", "L"],
    image: typeof value.image === "string" && value.image ? value.image : "/images/editorial-1.jpg",
    rating: Math.min(5, Math.max(0, Number(value.rating) || 0)),
    reviewCount: Math.max(0, Math.round(Number(value.reviewCount) || 0)),
    badge: ["New in", "Bestseller", "Last few"].includes(String(value.badge)) ? value.badge : void 0,
    stock: Math.max(0, Math.round(Number(value.stock) || 0)),
    collection,
    status: value.status === "draft" ? "draft" : "active",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : timestamp
  };
}
var MemoryStore = class {
  products = null;
  settings = {};
  ensure() {
    if (!this.products) this.products = SEED_PRODUCTS.map((product) => ({ ...product }));
    return this.products;
  }
  async listProducts() {
    return this.ensure().map((product) => ({ ...product }));
  }
  async getProduct(id) {
    const product = this.ensure().find((entry) => entry.id === id);
    return product ? { ...product } : void 0;
  }
  async saveProduct(product) {
    const products = this.ensure();
    const index = products.findIndex((entry) => entry.id === product.id);
    if (index >= 0) products[index] = product;
    else products.push(product);
  }
  async deleteProduct(id) {
    this.products = this.ensure().filter((product) => product.id !== id);
  }
  async readSettings() {
    return { ...this.settings };
  }
  async writeSettings(settings) {
    this.settings = { ...settings };
  }
};
async function resolveStripeKeys(ctx) {
  const settings = await ctx.store.readSettings();
  const envSecret = ctx.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const storedSecret = settings.stripeSecretKey?.trim() ?? "";
  const secretKey = envSecret || storedSecret;
  return {
    secretKey,
    webhookSecret: ctx.env.STRIPE_WEBHOOK_SECRET?.trim() || settings.stripeWebhookSecret?.trim() || "",
    secretSource: envSecret ? "env" : storedSecret ? "database" : "none"
  };
}

// src/server/productInput.ts
var BADGES = ["New in", "Bestseller", "Last few"];
var HEX = /^#[0-9a-fA-F]{6}$/;
var MAX_PRICE = 5e6;
function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}
function validateProductInput(input, existingProducts, existing, id) {
  const raw = input ?? {};
  const errors = {};
  const name = typeof raw.name === "string" ? raw.name.trim() : existing?.name ?? "";
  if (name.length < 2) errors.name = "Enter a product name.";
  if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  const category = CATEGORIES.find((entry) => entry.id === raw.category)?.id;
  if (!category) errors.category = "Choose a category.";
  const priceRaw = raw.price ?? existing?.price;
  const price = Math.round(Number(priceRaw));
  if (!Number.isFinite(price) || price <= 0) errors.price = "Enter a price above \xA30.";
  else if (price > MAX_PRICE) errors.price = "That price is too high.";
  let compareAt;
  if (raw.compareAt !== void 0 && raw.compareAt !== null && raw.compareAt !== "") {
    compareAt = Math.round(Number(raw.compareAt));
    if (!Number.isFinite(compareAt) || compareAt <= 0) errors.compareAt = "Enter a valid comparison price.";
    else if (Number.isFinite(price) && compareAt <= price) {
      errors.compareAt = "The comparison price must be higher than the price.";
    }
  }
  const stockRaw = raw.stock ?? existing?.stock ?? 0;
  const stock = Math.round(Number(stockRaw));
  if (!Number.isFinite(stock) || stock < 0) errors.stock = "Stock cannot be negative.";
  else if (stock > 99999) errors.stock = "That stock level is too high.";
  const shortDescription = typeof raw.shortDescription === "string" ? raw.shortDescription.trim() : existing?.shortDescription ?? "";
  if (shortDescription.length < 8) errors.shortDescription = "Add a one-line summary.";
  if (shortDescription.length > 220) errors.shortDescription = "Keep the summary under 220 characters.";
  const description = typeof raw.description === "string" ? raw.description.trim() : existing?.description ?? "";
  if (description.length < 20) errors.description = "Add a description of at least 20 characters.";
  const material = typeof raw.material === "string" ? raw.material.trim() : existing?.material ?? "";
  const details = (Array.isArray(raw.details) ? stringArray(raw.details) : existing?.details ?? []).slice(0, 20);
  const collection = Array.isArray(raw.collection) ? stringArray(raw.collection) : existing?.collection ?? [];
  const image = typeof raw.image === "string" ? raw.image.trim() : existing?.image ?? "";
  if (!image) errors.image = "Add an image path or URL.";
  else if (!/^(https?:\/\/|\/)/i.test(image)) {
    errors.image = "Use an https URL or a path starting with /.";
  }
  const coloursInput = Array.isArray(raw.colours) ? raw.colours : existing?.colours ?? [];
  const colours = [];
  for (const entry of coloursInput) {
    if (!entry || typeof entry !== "object") continue;
    const colour = entry;
    const colourName = String(colour.name ?? "").trim();
    const hex = String(colour.hex ?? "").trim();
    if (!colourName || !HEX.test(hex)) {
      errors.colours = "Each colour needs a name and a hex value like #1a1a1a.";
      break;
    }
    colours.push({ name: colourName.slice(0, 30), hex });
  }
  if (colours.length === 0) errors.colours = "Add at least one colour.";
  let sizes = Array.isArray(raw.sizes) ? stringArray(raw.sizes) : existing?.sizes ?? [];
  if (sizes.length === 0 && (category === "bags" || category === "watches")) sizes = ["One size"];
  if (sizes.length === 0) errors.sizes = "Add at least one size.";
  const rating = Math.min(5, Math.max(0, Number(raw.rating ?? existing?.rating ?? 0) || 0));
  const reviewCount = Math.max(0, Math.round(Number(raw.reviewCount ?? existing?.reviewCount ?? 0) || 0));
  let badge;
  if (typeof raw.badge === "string" && BADGES.includes(raw.badge)) {
    badge = raw.badge;
  } else if (raw.badge === "" || raw.badge === null) {
    badge = void 0;
  } else {
    badge = existing?.badge;
  }
  const status = raw.status === "draft" ? "draft" : "active";
  const baseSlug = slugify(typeof raw.slug === "string" && raw.slug.trim() ? raw.slug : name) || "piece";
  const taken = new Set(
    existingProducts.filter((product) => product.id !== existing?.id).map((product) => product.slug)
  );
  let slug = baseSlug;
  let suffix = 2;
  while (taken.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  if (Object.keys(errors).length > 0) return { errors };
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    product: {
      id: existing?.id ?? id ?? `pr_${Math.random().toString(36).slice(2, 10)}`,
      slug,
      name,
      category,
      price,
      compareAt,
      shortDescription,
      description,
      material,
      details,
      colours,
      sizes,
      image,
      rating,
      reviewCount,
      badge,
      stock,
      collection,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  };
}

// src/server/stripe.ts
var StripeError = class extends Error {
  status;
  code;
  constructor(message, status = 400, code) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
  }
};
function encode(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== "") body.append(key, String(value));
  }
  return body;
}
async function stripeFetch(path, secretKey, init) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: init.body?.toString()
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new StripeError("Stripe returned an unexpected response.", 502);
  }
  if (!response.ok) {
    throw new StripeError(
      payload?.error?.message ?? "Stripe rejected the request.",
      response.status,
      payload?.error?.code
    );
  }
  return payload;
}
async function createStripeCheckoutSession(secretKey, input) {
  const body = new URLSearchParams();
  body.append("mode", "payment");
  body.append("success_url", input.successUrl);
  body.append("cancel_url", input.cancelUrl);
  body.append("locale", "en-GB");
  body.append("billing_address_collection", "auto");
  body.append("shipping_address_collection[allowed_countries][0]", "GB");
  body.append("shipping_address_collection[allowed_countries][1]", "IE");
  body.append("phone_number_collection[enabled]", "true");
  body.append("metadata[order_id]", input.orderId);
  if (input.email) body.append("customer_email", input.email);
  if (input.promoCode) body.append("metadata[promo_code]", input.promoCode);
  input.lines.forEach((line, index) => {
    body.append(`line_items[${index}][quantity]`, String(line.quantity));
    body.append(`line_items[${index}][price_data][currency]`, "gbp");
    body.append(`line_items[${index}][price_data][unit_amount]`, String(line.unitAmount));
    body.append(`line_items[${index}][price_data][product_data][name]`, line.name);
    if (line.description) {
      body.append(`line_items[${index}][price_data][product_data][description]`, line.description);
    }
    if (line.image) {
      body.append(`line_items[${index}][price_data][product_data][images][0]`, line.image);
    }
  });
  if (input.discountAmount && input.discountAmount > 0 && input.promoCode) {
    const couponId = await ensureCoupon(secretKey, input.promoCode, input.discountAmount);
    body.append("discounts[0][coupon]", couponId);
  }
  const session = await stripeFetch("checkout/sessions", secretKey, { method: "POST", body });
  const url = session.url;
  if (!url) throw new StripeError("Stripe did not return a checkout URL.", 502);
  return { id: String(session.id), url };
}
async function ensureCoupon(secretKey, code, amountOff) {
  const couponId = `halcyon_${code.toLowerCase()}_${amountOff}`;
  try {
    await stripeFetch(
      "coupons",
      secretKey,
      {
        method: "POST",
        body: encode({
          id: couponId,
          amount_off: amountOff,
          currency: "gbp",
          duration: "once",
          name: `${code} promotion`
        })
      }
    );
  } catch (error) {
    if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
  }
  return couponId;
}
async function retrieveStripeSession(secretKey, sessionId) {
  const query = new URLSearchParams();
  query.append("expand[]", "line_items");
  query.append("expand[]", "total_details.breakdown");
  const session = await stripeFetch(
    `checkout/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`,
    secretKey,
    { method: "GET" }
  );
  return {
    id: String(session.id),
    status: String(session.status),
    paymentStatus: String(session.payment_status),
    email: session.customer_details?.email ?? session.customer_email ?? void 0,
    amountTotal: Number(session.amount_total ?? 0),
    amountSubtotal: Number(session.amount_subtotal ?? 0),
    amountDiscount: Number(session.total_details?.amount_discount ?? 0),
    amountShipping: Number(session.total_details?.amount_shipping ?? 0),
    currency: String(session.currency ?? "gbp"),
    created: Number(session.created ?? 0),
    orderId: session.metadata?.order_id,
    promoCode: session.metadata?.promo_code,
    lines: (session.line_items?.data ?? []).map((line) => ({
      name: String(line.description ?? "Item"),
      quantity: Number(line.quantity ?? 1),
      amount: Number(line.amount_subtotal ?? line.amount_total ?? line.amount ?? 0)
    })),
    shippingAddress: session.shipping_details?.address ?? void 0
  };
}
async function verifyStripeSignature(payload, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key2, value] = part.split("=");
      return [key2.trim(), value];
    })
  );
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1e3 - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parts.t}.${payload}`)
  );
  const expected = Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const signatures = signatureHeader.split(",")
    .map((part) => part.trim().split("="))
    .filter(([name]) => name === "v1")
    .map(([, value]) => value);
  return signatures.some((provided) => {
  if (typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
  });
}

// src/server/handler.ts
var MAX_LINES = 20;
async function handleApi(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  try {
    if (path === "/api/config" && method === "GET") return await getConfig(ctx);
    if (path === "/api/products" && method === "GET") return await getCatalogue(ctx);
    if (path === "/api/checkout" && method === "POST") return await postCheckout(request, ctx);
    if (path === "/api/checkout/session" && method === "GET") return await getSession(request, ctx);
    if (path === "/api/webhook" && method === "POST") return await postWebhook(request, ctx);
    if (path === "/api/admin" || path.startsWith("/api/admin/")) {
      return await handleAdmin(request, ctx, path.slice("/api/admin".length) || "/", method);
    }
    return badRequest("Not found.", 404);
  } catch (error) {
    console.error("api error", error);
    return badRequest("Something went wrong. Please try again.", 500);
  }
}
async function getConfig(ctx) {
  const keys = await resolveStripeKeys(ctx);
  return json({
    stripeEnabled: Boolean(keys.secretKey),
    currency: "GBP",
    secretSource: keys.secretSource
  });
}
async function getCatalogue(ctx) {
  const products = (await ctx.store.listProducts()).filter((product) => product.status === "active");
  products.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return json({ products, currency: "GBP" });
}
function validateCart(raw, products) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Your basket is empty." };
  if (raw.length > MAX_LINES) return { error: "Too many different items in one order." };
  const sellable = products.filter((product) => product.status === "active");
  const cleaned = [];
  let totalQty = 0;
  const quantities = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { error: "Malformed basket item." };
    const item = entry;
    const product = sellable.find((candidate) => candidate.id === String(item.productId ?? ""));
    if (!product) return { error: "One of the items is no longer available." };
    const size = product.sizes.includes(String(item.size)) ? String(item.size) : product.sizes[0];
    const colour = product.colours.some((c) => c.name === item.colour) ? String(item.colour) : product.colours[0].name;
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      return { error: "Quantities must be between 1 and 10." };
    }
    const productQty = (quantities.get(product.id) ?? 0) + qty;
    if (productQty > product.stock) return { error: "There is insufficient stock for " + product.name + "." };
    quantities.set(product.id, productQty);
    totalQty += qty;
    if (totalQty > 40) return { error: "This order exceeds our limit of 40 items." };
    cleaned.push({ productId: product.id, size, colour, qty });
  }
  const lines = resolveLines(cleaned, sellable);
  if (lines.length === 0) return { error: "Your basket is empty." };
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  return { lines, subtotal };
}
function normaliseEmail(raw) {
  if (typeof raw !== "string") return void 0;
  const email = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : void 0;
}
async function postCheckout(request, ctx) {
  const payload = await readJson(request);
  if (!payload) return badRequest("Invalid request body.");
  const products = await ctx.store.listProducts();
  const cart = validateCart(payload.items, products);
  if ("error" in cart) return badRequest(cart.error);
  const delivery = getDeliveryOption(
    typeof payload.delivery === "string" ? payload.delivery : void 0
  );
  const email = normaliseEmail(payload.email);
  const customerName = typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "";
  const promoInput = typeof payload.promo === "string" ? payload.promo : void 0;
  const totals = computeTotals(cart.subtotal, delivery.id, promoInput);
  const promo = totals.promo;
  const orderId = `HLY-${crypto.randomUUID().toUpperCase()}`;
  const origin = siteOrigin(request, ctx.env.SITE_URL);
  const keys = await resolveStripeKeys(ctx);
  const baseOrder = {
    id: orderId,
    number: orderId,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    email,
    items: cart.lines.map((line) => ({
      name: line.product.name,
      size: line.size,
      colour: line.colour,
      qty: line.qty,
      unitPrice: line.product.price,
      total: line.lineTotal,
      image: line.product.image
    })),
    subtotal: totals.subtotal,
    discount: totals.discount,
    delivery: totals.delivery,
    total: totals.total,
    deliveryName: delivery.name,
    deliveryEta: delivery.eta,
    promoCode: promo?.code,
    carrier: delivery.id === "standard" ? "Royal Mail Tracked 24" : "DPD Next Day",
    addressSummary: customerName || void 0
  };
  if (!keys.secretKey) {
    return json({
      mode: "sandbox",
      order: { ...baseOrder, status: "paid", mode: "sandbox" }
    });
  }
  try {
    const lines = cart.lines.map((line) => ({
      name: line.product.name,
      description: `${line.colour} \xB7 ${line.size}${line.qty > 1 ? ` \xB7 ${line.qty}\xD7` : ""}`,
      image: absoluteUrl(origin, line.product.image),
      unitAmount: line.product.price,
      quantity: line.qty
    }));
    if (totals.delivery > 0) {
      lines.push({
        name: delivery.name,
        description: delivery.eta,
        image: "",
        unitAmount: totals.delivery,
        quantity: 1
      });
    }
    const session = await createStripeCheckoutSession(keys.secretKey, {
      lines,
      email,
      successUrl: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/checkout?cancelled=1`,
      orderId,
      promoCode: promo?.code,
      discountAmount: totals.discount,
      metadata: customerName ? { customer_name: customerName } : void 0
    });
    return json({ mode: "stripe", url: session.url, orderId: session.id });
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("stripe checkout failed", error.status, error.code, error.message);
      const message = error.status === 401 ? "The configured Stripe key was rejected. Check the key in the admin settings." : error.message;
      return badRequest(message, error.status >= 500 ? 502 : 400);
    }
    console.error("checkout failed", error);
    return badRequest("We could not start the payment. Please try again.", 500);
  }
}
async function getSession(request, ctx) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return badRequest("Missing checkout session id.");
  const keys = await resolveStripeKeys(ctx);
  if (!keys.secretKey) return badRequest("Payments are not configured on this deployment.", 503);
  try {
    const session = await retrieveStripeSession(keys.secretKey, id);
    const products = await ctx.store.listProducts();
    const deliveryNames = DELIVERY_OPTIONS.map((option) => option.name);
    const deliveryLines = session.lines.filter((line) => deliveryNames.includes(line.name));
    const merchandise = session.lines.filter((line) => !deliveryNames.includes(line.name));
    const deliveryAmount = deliveryLines.reduce((sum, line) => sum + line.amount, 0) || session.amountShipping;
    const deliveryName = deliveryLines[0]?.name ?? getDeliveryOption(void 0).name;
    const deliveryOption = DELIVERY_OPTIONS.find((option) => option.name === deliveryName);
    return json({
      mode: "stripe",
      order: {
        id: session.id,
        number: session.orderId ?? session.id,
        createdAt: new Date(session.created * 1e3).toISOString(),
        email: session.email,
        items: merchandise.map((line) => {
          const match = products.find((product) => line.name.startsWith(product.name));
          return {
            name: line.name,
            size: "",
            colour: "",
            qty: line.quantity,
            unitPrice: Math.round(line.amount / Math.max(1, line.quantity)),
            total: line.amount,
            image: match?.image ?? "/images/editorial-1.jpg"
          };
        }),
        subtotal: Math.max(0, session.amountSubtotal - deliveryAmount),
        discount: session.amountDiscount,
        delivery: deliveryAmount,
        total: session.amountTotal,
        deliveryName,
        deliveryEta: deliveryOption?.eta ?? "2\u20134 working days",
        promoCode: session.promoCode,
        status: session.paymentStatus === "paid" ? "paid" : "pending",
        mode: "stripe",
        carrier: deliveryOption?.id === "standard" ? "Royal Mail Tracked 24" : "DPD Next Day",
        addressSummary: session.shippingAddress?.city ?? void 0
      }
    });
  } catch (error) {
    if (error instanceof StripeError) {
      return badRequest(error.message, error.status >= 500 ? 502 : 400);
    }
    return badRequest("We could not find that payment.", 500);
  }
}
async function postWebhook(request, ctx) {
  const keys = await resolveStripeKeys(ctx);
  if (!keys.webhookSecret) return badRequest("Webhook is not configured.", 503);
  const payload = await request.text();
  const valid = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature"),
    keys.webhookSecret
  );
  if (!valid) return badRequest("Invalid signature.", 400);
  try {
    const event = JSON.parse(payload);
    if (event.type === "checkout.session.completed") {
      const session = event.data?.object ?? {};
      console.log("order paid", session.id, session.amount_total);
    }
    return json({ received: true });
  } catch {
    return badRequest("Invalid payload.");
  }
}
var loginAttempts = /* @__PURE__ */ new Map();
function attemptKey(request) {
  return clientAddress(request);
}
function throttleLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1e3 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 8;
}
function clearAttempts(ip) {
  loginAttempts.delete(ip);
}
function maskKey(key) {
  if (!key) return { configured: false, mode: "other", last4: "" };
  const mode = key.startsWith("sk_live") ? "live" : key.startsWith("sk_test") ? "test" : "other";
  return { configured: true, mode, last4: key.slice(-4) };
}
async function requireAdmin(request, ctx) {
  const password = ctx.env.ADMIN_PASSWORD?.trim();
  if (!password) return false;
  return verifySessionToken(readCookie(request, ADMIN_COOKIE_NAME), sessionSecret(ctx.env));
}
async function settingsPayload(ctx) {
  const settings = await ctx.store.readSettings();
  const envSecret = ctx.env.STRIPE_SECRET_KEY?.trim();
  const envWebhook = ctx.env.STRIPE_WEBHOOK_SECRET?.trim();
  const secret = maskKey(envSecret || settings.stripeSecretKey);
  const webhookKey = envWebhook || settings.stripeWebhookSecret;
  return {
    stripe: {
      ...secret,
      source: envSecret ? "env" : settings.stripeSecretKey ? "database" : "none",
      envOverride: Boolean(envSecret)
    },
    webhook: {
      configured: Boolean(webhookKey),
      last4: webhookKey ? webhookKey.slice(-4) : "",
      source: envWebhook ? "env" : settings.stripeWebhookSecret ? "database" : "none",
      envOverride: Boolean(envWebhook)
    }
  };
}
async function handleAdmin(request, ctx, adminPath, method) {
  const path = adminPath || "/";
  if (path === "/login" && method === "POST") {
    if (!isSameOrigin(request)) return badRequest("Cross-origin request blocked.", 403);
    const password = ctx.env.ADMIN_PASSWORD?.trim();
    if (!password) {
      return badRequest(
        "Admin access is not configured. Set ADMIN_PASSWORD in the environment, then reload.",
        503
      );
    }
    const ip = attemptKey(request);
    if (!throttleLogin(ip)) {
      return badRequest("Too many attempts. Try again in ten minutes.", 429);
    }
    const body = await readJson(request);
    const submitted = typeof body?.password === "string" ? body.password : "";
    if (!await passwordMatches(submitted, password)) {
      return badRequest("That password is not correct.", 401);
    }
    clearAttempts(ip);
    const token = await createSessionToken(sessionSecret(ctx.env));
    const secure = new URL(request.url).protocol === "https:";
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, secure) });
  }
  if (path === "/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  }
  if (path === "/session" && method === "GET") {
    if (!ctx.env.ADMIN_PASSWORD?.trim()) {
      return badRequest("Admin access is not configured. Set ADMIN_PASSWORD.", 503);
    }
    const authenticated2 = await requireAdmin(request, ctx);
    if (!authenticated2) return badRequest("Sign in required.", 401);
    return json({ authenticated: true, settings: await settingsPayload(ctx) });
  }
  const authenticated = await requireAdmin(request, ctx);
  if (!authenticated) return badRequest("Sign in required.", 401);
  if (method !== "GET" && !isSameOrigin(request)) {
    return badRequest("Cross-origin request blocked.", 403);
  }
  if (path === "/products" && method === "GET") {
    const products = await ctx.store.listProducts();
    products.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json({ products });
  }
  if (path === "/products" && method === "POST") {
    const body = await readJson(request);
    if (!body) return badRequest("Invalid product payload.");
    const products = await ctx.store.listProducts();
    const result = validateProductInput(body, products);
    if (result.errors) return json({ errors: result.errors }, 422);
    await ctx.store.saveProduct(result.product);
    return json({ product: result.product }, 201);
  }
  const match = path.match(/^\/products\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (method === "GET") {
      const product = await ctx.store.getProduct(id);
      if (!product) return badRequest("Product not found.", 404);
      return json({ product });
    }
    if (method === "PUT") {
      const body = await readJson(request);
      if (!body) return badRequest("Invalid product payload.");
      const products = await ctx.store.listProducts();
      const existing = products.find((product) => product.id === id);
      if (!existing) return badRequest("Product not found.", 404);
      const result = validateProductInput({ ...existing, ...body }, products, existing);
      if (result.errors) return json({ errors: result.errors }, 422);
      await ctx.store.saveProduct(result.product);
      return json({ product: result.product });
    }
    if (method === "DELETE") {
      const products = await ctx.store.listProducts();
      if (!products.some((product) => product.id === id)) {
        return badRequest("Product not found.", 404);
      }
      await ctx.store.deleteProduct(id);
      return json({ ok: true });
    }
  }
  if (path === "/settings" && method === "GET") {
    return json(await settingsPayload(ctx));
  }
  if (path === "/settings" && method === "PUT") {
    const body = await readJson(request);
    if (!body) return badRequest("Invalid settings payload.");
    const settings = { ...await ctx.store.readSettings() };
    if (body.clearStripeSecretKey) {
      delete settings.stripeSecretKey;
    } else if (typeof body.stripeSecretKey === "string" && body.stripeSecretKey.trim()) {
      const key = body.stripeSecretKey.trim();
      if (!/^sk_(test|live)_[A-Za-z0-9_]+$/.test(key)) {
        return badRequest("That does not look like a Stripe secret key (sk_test_\u2026 or sk_live_\u2026).", 422);
      }
      settings.stripeSecretKey = key;
    }
    if (body.clearStripeWebhookSecret) {
      delete settings.stripeWebhookSecret;
    } else if (typeof body.stripeWebhookSecret === "string" && body.stripeWebhookSecret.trim()) {
      const key = body.stripeWebhookSecret.trim();
      if (!/^whsec_[A-Za-z0-9_]+$/.test(key)) {
        return badRequest("That does not look like a webhook signing secret (whsec_\u2026).", 422);
      }
      settings.stripeWebhookSecret = key;
    }
    await ctx.store.writeSettings(settings);
    if (ctx.env.STRIPE_SECRET_KEY?.trim() || ctx.env.STRIPE_WEBHOOK_SECRET?.trim()) {
      return json({ ...await settingsPayload(ctx), note: "Deployment secrets take precedence over saved values." });
    }
    return json(await settingsPayload(ctx));
  }
  return badRequest("Not found.", 404);
}

// src/server/d1Store.ts
var D1Store = class {
  constructor(db) {
    this.db = db;
  }
  db;
  ready = null;
  init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.prepare(
          "CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
        ).run();
        await this.db.prepare(
          "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        ).run();
        const seeded = await this.db.prepare("SELECT value FROM settings WHERE key = 'catalogue_seeded'").first();
        if (!seeded) {
          const count = await this.db.prepare("SELECT COUNT(*) AS total FROM products").first();
          if (!count || Number(count.total) === 0) {
            for (const product of SEED_PRODUCTS) {
              await this.db.prepare("INSERT OR IGNORE INTO products (id, data, updated_at) VALUES (?, ?, ?)").bind(product.id, JSON.stringify(product), product.updatedAt).run();
            }
          }
          await this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('catalogue_seeded', '1')").run();
        }
      })();
    }
    return this.ready;
  }
  async listProducts() {
    await this.init();
    const result = await this.db.prepare("SELECT data FROM products ORDER BY updated_at DESC").all();
    return (result.results ?? []).map((row) => {
      try {
        return normaliseProduct(JSON.parse(row.data));
      } catch {
        return null;
      }
    }).filter((product) => Boolean(product));
  }
  async getProduct(id) {
    await this.init();
    const row = await this.db.prepare("SELECT data FROM products WHERE id = ?").bind(id).first();
    if (!row) return void 0;
    try {
      return normaliseProduct(JSON.parse(row.data)) ?? void 0;
    } catch {
      return void 0;
    }
  }
  async saveProduct(product) {
    await this.init();
    await this.db.prepare("INSERT OR REPLACE INTO products (id, data, updated_at) VALUES (?, ?, ?)").bind(product.id, JSON.stringify(product), product.updatedAt).run();
  }
  async deleteProduct(id) {
    await this.init();
    await this.db.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  }
  async readSettings() {
    await this.init();
    const result = await this.db.prepare("SELECT value FROM settings WHERE key = 'stripe'").first();
    if (!result) return {};
    try {
      return JSON.parse(result.value);
    } catch {
      return {};
    }
  }
  async writeSettings(settings) {
    await this.init();
    await this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('stripe', ?)").bind(JSON.stringify(settings)).run();
  }
};

// worker/index.ts
var stores = new WeakMap();
var memoryStore = new MemoryStore();
function storeFor(env) {
  if (!env.DB) return memoryStore;
  if (!stores.has(env.DB)) stores.set(env.DB, new D1Store(env.DB));
  return stores.get(env.DB);
}
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, { env, store: storeFor(env) });
    }
    const response = await env.ASSETS.fetch(request);
    if (response.status === 404 && request.method === "GET" && !url.pathname.split("/").pop()?.includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return response;
  }
};
export {
  index_default as default
};
