function formatPricing(location) {
  const pricing = location.pricing?.standard;
  if (!pricing) return "Pricing: unknown";

  const parts = [];

  if (pricing.dockage_rate === 0) {
    parts.push("dockage free");
  } else if (typeof pricing.dockage_rate === "number") {
    parts.push(`dockage ${pricing.dockage_rate} ${location.pricing?.currency || "USD"}`);
  } else {
    parts.push("dockage rate unknown");
  }

  if (pricing.rate_basis) parts.push(`basis=${pricing.rate_basis}`);

  if (typeof pricing.electric_rate === "number") {
    parts.push(
      `electric=${pricing.electric_rate} ${location.pricing?.currency || "USD"} ${pricing.electric_rate_basis || ""}`.trim()
    );
  }

  if (typeof pricing.pumpout_rate === "number") {
    parts.push(`pumpout=${pricing.pumpout_rate} ${location.pricing?.currency || "USD"}`);
  }

  if (pricing.notes) parts.push(`notes=${pricing.notes}`);

  return `Pricing: ${parts.join(", ")}`;
}

function formatContacts(location) {
  const contact = location.contact || {};
  const parts = [];

  if (contact.phone) parts.push(`phone=${contact.phone}`);
  if (contact.email) parts.push(`email=${contact.email}`);
  if (contact.website) parts.push(`website=${contact.website}`);
  if (contact.vhf) parts.push(`vhf=${contact.vhf}`);
  if (contact.camera_url) parts.push(`camera=${contact.camera_url}`);

  if (!parts.length) return "Contact: none listed";
  return `Contact: ${parts.join(", ")}`;
}

function formatServiceAssociations(location) {
  const associations = Array.isArray(location.service_associations)
    ? location.service_associations
    : [];

  if (!associations.length) return [];

  return associations.map((item) => {
    return `Service association: service=${item.service || "unknown"}, relationship=${item.relationship || "unknown"}, note=${item.plain || "none"}`;
  });
}

function formatExpertMaterial(location) {
  const lines = [];
  const seen = new Set();

  const pushLogbookLine = (prefix, value) => {
    if (typeof value !== "string") return;
    const clean = String(value)
      .replace(/^sail to the sun expert opinion:\s*/i, "")
      .replace(/^sail to the sun logbook:\s*/i, "")
      .trim();

    if (!clean) return;
    const dedupeKey = `${prefix}::${clean}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    lines.push(`${prefix}: ${clean}`);
  };

  if (location.local_knowledge) {
    lines.push(
      `Local knowledge: source=${location.local_knowledge.source_name || "unknown"}, basis=${location.local_knowledge.basis || "unknown"}, confidence=${location.local_knowledge.confidence ?? "unknown"}`
    );
  }

  pushLogbookLine("Sail to the Sun Logbook note", location.expert_notes?.plain);

  if (location.expert_notes?.for_budget_cruisers) {
    lines.push(`Logbook note (budget): ${location.expert_notes.for_budget_cruisers}`);
  }

  if (location.expert_notes?.for_deep_draft) {
    lines.push(`Logbook note (deep draft): ${location.expert_notes.for_deep_draft}`);
  }

  if (location.expert_notes?.for_singlehanders) {
    lines.push(`Logbook note (singlehanders): ${location.expert_notes.for_singlehanders}`);
  }

  if (location.local_notes && typeof location.local_notes === "object") {
    Object.values(location.local_notes).forEach((value) => {
      pushLogbookLine("Sail to the Sun Logbook context", value);
    });
  }

  return lines;
}

function formatCautions(location) {
  if (!location.cautions?.length) return [];

  const cautionLines = location.cautions.map((c) => {
    return `[severity ${c.severity}] ${c.text}`;
  });

  const strongCautions = location.cautions
    .filter((c) => typeof c.severity === "number" && c.severity >= 0.85)
    .map((c) => c.text);

  const lines = [];
  lines.push(`Cautions: ${cautionLines.join(" | ")}`);

  if (strongCautions.length) {
    lines.push(`High-severity operational cautions: ${strongCautions.join(" | ")}`);
  }

  return lines;
}

function formatDistance(location) {
  if (location.ranking?.distance_unit === "icw_miles") {
    return `Distance from requested stopping point: ${location.ranking.distance_icw_miles} ICW miles`;
  }

  if (location.ranking?.distance_mode === "direct_match") {
    return "Distance: direct match";
  }

  return `Distance from query point: ${location.ranking?.distance_nm ?? "Unknown"} NM`;
}

function formatOneLocation(location) {
  const lines = [];

  lines.push(`Name: ${location.name}`);
  lines.push(`Type: ${location.type}`);
  lines.push(`Segment: ${location.geo?.segment ?? "Unknown"}`);

  if (typeof location.geo?.icw_mile === "number") {
    lines.push(`ICW mile marker: ${location.geo.icw_mile}`);
  }

  lines.push(formatDistance(location));
  lines.push(`Ranking score: ${location.ranking?.final_score ?? "Unknown"}`);

  if (location.type === "marina") {
    lines.push(
      `Depth: reported ${location.depth?.reported_ft_mlw ?? "unknown"} ft MLW, approach ${location.depth?.approach_ft_mlw ?? "unknown"} ft MLW, dockside ${location.depth?.dockside_ft_mlw ?? "unknown"} ft MLW`
    );
    lines.push(
      `Services: transient slips=${location.access?.transient_slips}, fuel=${location.access?.fuel}, pumpout=${location.access?.pumpout}, water=${location.access?.water}, shore power=${location.access?.shore_power}, laundry=${location.access?.laundry}, repairs=${location.access?.repairs}`
    );
  }

  if (location.type === "mooring_field") {
    lines.push(
      `Depth: reported ${location.depth?.reported_ft_mlw ?? "unknown"} ft MLW, approach ${location.depth?.approach_ft_mlw ?? "unknown"} ft MLW`
    );
    lines.push(
      `Services: launch service=${location.access?.launch_service}, dinghy access=${location.access?.dinghy_access}, pumpout=${location.access?.pumpout}, showers=${location.access?.showers}, laundry=${location.access?.laundry}`
    );
  }

  if (
    location.type === "free_dock" ||
    location.type === "town_dock" ||
    location.type === "low_cost_dock" ||
    location.type === "day_dock"
  ) {
    lines.push(
      `Depth: reported ${location.depth?.reported_ft_mlw ?? "unknown"} ft MLW, approach ${location.depth?.approach_ft_mlw ?? "unknown"} ft MLW, dockside ${location.depth?.dockside_ft_mlw ?? "unknown"} ft MLW`
    );
    lines.push(
      `Dock policy: overnight allowed=${location.access?.overnight_allowed}, day use only=${location.access?.day_use_only}, max stay hours=${location.access?.max_stay_hours ?? "unknown"}, power=${location.access?.shore_power}, water=${location.access?.water}, pumpout=${location.access?.pumpout}, restrooms=${location.access?.restrooms}`
    );
  }

  if (location.type === "anchorage") {
    lines.push(
      `Depth: typical ${location.depth?.typical_ft_mlw ?? "unknown"} ft MLW, shallow spots ${location.depth?.shallow_spots_ft_mlw ?? "unknown"} ft MLW`
    );
    lines.push(
      `Holding: ${location.holding?.bottom_type?.join(", ") ?? "unknown"}; quality score ${location.holding?.holding_quality_score ?? "unknown"}`
    );
  }

  lines.push(formatPricing(location));
  lines.push(formatContacts(location));

  lines.push(
    `Shore access: groceries=${location.shore_access?.groceries_nearby}, restaurants=${location.shore_access?.restaurants_nearby}, marine store=${location.shore_access?.marine_store_nearby}, walkability=${location.shore_access?.walkability_score ?? "unknown"}`
  );

  lines.push(
    `Protection: wake exposure=${location.protection?.wake_exposure_score ?? "unknown"}, current exposure=${location.protection?.current_exposure_score ?? "unknown"}`
  );

  if (location.vessel_fit) {
    lines.push(
      `Vessel fit: big boat friendly=${location.vessel_fit?.big_boat_friendly}, max LOA=${location.vessel_fit?.max_comfortable_loa_ft ?? "unknown"}, handling difficulty=${location.vessel_fit?.dock_handling_difficulty_score ?? "unknown"}`
    );
  }

  lines.push(...formatServiceAssociations(location));
  lines.push(...formatExpertMaterial(location));
  lines.push(...formatCautions(location));

  if (location.ranking?.explanation?.length) {
    lines.push(`Why ranked well: ${location.ranking.explanation.join("; ")}`);
  }

  lines.push(`Confidence: ${location.status?.confidence ?? "unknown"}`);
  lines.push(`Last curated: ${location.status?.last_curated ?? "unknown"}`);

  return lines.join("\n");
}

function formatTopLocations(rankedLocations, maxItems = 12) {
  return rankedLocations
    .slice(0, maxItems)
    .map((location, index) => `Candidate ${index + 1}\n${formatOneLocation(location)}`)
    .join("\n\n---------------------\n\n");
}

module.exports = { formatTopLocations };