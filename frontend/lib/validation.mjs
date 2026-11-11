// Pure validation helpers shared by the UI and tests. No dependencies.

export function isHexString(s, bytes, { prefix = "optional" } = {}) {
  if (typeof s !== "string" || s.length === 0) return false;
  let body = s;
  const hasPrefix = s.startsWith("0x") || s.startsWith("0X");
  if (hasPrefix) body = s.slice(2);
  else if (prefix === "required") return false;
  if (body.length !== bytes * 2) return false;
  return /^[0-9a-fA-F]+$/.test(body);
}

export const isEvmAddress = (s) => isHexString(s, 20);

export function isRepoSlug(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 128) return false;
  const parts = s.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return false;
  return parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p));
}

export function buildPrUrl(repo, prNumber) {
  return `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
}

/// Validate the structural shape of a pasted proof (SDK `transformForOnchain`
/// output or zk-fetch result). Returns { ok, errors[], normalized? }.
/// Semantic verification happens on-chain; this only rejects malformed input.
export function validateProofShape(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["proof must be an object"] };

  // Accept both zk-fetch output ({claimData, signatures}) and on-chain
  // shape ({claimInfo, signedClaim}); normalize to on-chain shape.
  let claimInfo = input.claimInfo;
  let claim;
  let signatures = input.signatures;
  if (input.claimData) {
    const cd = input.claimData;
    claimInfo = { provider: cd.provider, parameters: cd.parameters, context: cd.context };
    claim = { identifier: cd.identifier, owner: cd.owner, epoch: cd.epoch, timestampS: cd.timestampS };
  } else if (input.signedClaim?.claim) {
    claim = input.signedClaim.claim;
    signatures = input.signedClaim.signatures;
  }
  if (!claimInfo || typeof claimInfo !== "object") errors.push("missing claimInfo/claimData");
  else {
    for (const f of ["provider", "parameters", "context"]) {
      if (typeof claimInfo[f] !== "string" || claimInfo[f].length === 0) errors.push(`claimInfo.${f} must be a non-empty string`);
    }
    if (typeof claimInfo.parameters === "string" && claimInfo.parameters.length > 16384) {
      errors.push("parameters exceed 16KB");
    }
    if (typeof claimInfo.context === "string" && claimInfo.context.length > 16384) {
      errors.push("context exceeds 16KB");
    }
    if (typeof claimInfo.provider === "string" && claimInfo.provider !== "http") {
      errors.push("provider must be 'http'");
    }
  }
  if (!claim || typeof claim !== "object") errors.push("missing claim");
  else {
    if (!isHexString(claim.identifier, 32)) errors.push("claim.identifier must be 32-byte hex");
    if (!isEvmAddress(claim.owner)) errors.push("claim.owner must be an EVM address");
    if (!Number.isInteger(claim.epoch) || claim.epoch < 0) errors.push("claim.epoch must be a uint");
    if (!Number.isInteger(claim.timestampS) || claim.timestampS < 0) errors.push("claim.timestampS must be a uint");
  }
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > 16) {
    errors.push("signatures must be a non-empty array (max 16)");
  } else {
    signatures.forEach((s, i) => {
      if (!isHexString(s, 65)) errors.push(`signatures[${i}] must be 65-byte hex`);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: {
      claimInfo: { provider: claimInfo.provider, parameters: claimInfo.parameters, context: claimInfo.context },
      signedClaim: {
        claim: { identifier: claim.identifier, owner: claim.owner, epoch: claim.epoch, timestampS: claim.timestampS },
        signatures: [...signatures],
      },
    },
  };
}

export function validateBountyInput({ repo, prNumber, token, amount }) {
  const errors = [];
  if (!isRepoSlug(repo)) errors.push("repo must look like 'owner/name'");
  if (!Number.isInteger(prNumber) || prNumber <= 0) errors.push("prNumber must be a positive integer");
  if (!isEvmAddress(token)) errors.push("token must be an EVM address");
  try {
    if (BigInt(amount) <= 0n) errors.push("amount must be positive");
  } catch {
    errors.push("amount must be a decimal integer string");
  }
  return { ok: errors.length === 0, errors };
}

/// Parse a human USDC amount ("1", "1.5", "0.000001") into base units
/// (6 decimals). Strict: no exponents, no signs, no grouping separators,
/// at most 6 fractional digits, must be positive. Returns
/// { ok, errors[], baseUnits? } with baseUnits a decimal integer string.
export function parseUsdcToBaseUnits(input) {
  const errors = [];
  const raw = typeof input === "number" ? String(input) : input;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, errors: ["amount must be a positive number"] };
  }
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { ok: false, errors: ["amount must look like '25' or '25.50' (no signs, exponents, or commas)"] };
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 6) {
    return { ok: false, errors: ["USDC has 6 decimals, so at most 6 digits after the point"] };
  }
  const baseUnits = (BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();
  if (BigInt(baseUnits) <= 0n) errors.push("amount must be positive");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], baseUnits };
}

/// Validate a sponsor-form deadline. Accepts ""/null (no deadline) or a
/// `datetime-local` value ("YYYY-MM-DDTHH:mm", interpreted as local time).
/// Returns { ok, errors[], expiry } with expiry a unix-seconds number
/// (0 = no deadline, matching the contract's convention).
export function validateDeadline(value) {
  if (value === "" || value === null || value === undefined) {
    return { ok: true, errors: [], expiry: 0 };
  }
  if (typeof value !== "string") return { ok: false, errors: ["deadline must be empty or a date"] };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return { ok: false, errors: ["deadline must be a date and time"] };
  const dt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  );
  // Reject rollover dates (month 13, day 32, hour 25, ...) — JS would
  // silently wrap them into a different real date.
  if (
    dt.getFullYear() !== Number(m[1]) ||
    dt.getMonth() !== Number(m[2]) - 1 ||
    dt.getDate() !== Number(m[3]) ||
    dt.getHours() !== Number(m[4]) ||
    dt.getMinutes() !== Number(m[5])
  ) {
    return { ok: false, errors: ["deadline is not a real date"] };
  }
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return { ok: false, errors: ["deadline is not a real date"] };
  const expiry = Math.floor(ms / 1000);
  if (expiry * 1000 <= Date.now()) return { ok: false, errors: ["deadline must be in the future"] };
  return { ok: true, errors: [], expiry };
}

/// Validate the whole sponsor form. Returns { ok, errors[], params? } with
/// params = { bounty_id, repo, pr_number, amount, expiry } ready for
/// `create_bounty` (the caller adds the fixed USDC token address).
export function validateSponsorForm({ bountyId, repo, prNumber, amountUsdc, deadline }) {
  const errors = [];
  const id = typeof bountyId === "string" && bountyId.trim() !== "" ? Number(bountyId) : bountyId;
  if (!Number.isInteger(id) || id < 0) errors.push("bounty ID must be a non-negative integer");
  if (!isRepoSlug(typeof repo === "string" ? repo.trim() : repo)) {
    errors.push("repo must look like 'owner/name'");
  }
  const pr = typeof prNumber === "string" && prNumber.trim() !== "" ? Number(prNumber) : prNumber;
  if (!Number.isInteger(pr) || pr <= 0) errors.push("PR number must be a positive integer");
  const amount = parseUsdcToBaseUnits(amountUsdc);
  errors.push(...amount.errors);
  const dl = validateDeadline(deadline);
  errors.push(...dl.errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    params: {
      bounty_id: id,
      repo: repo.trim(),
      pr_number: pr,
      amount: amount.baseUnits,
      expiry: dl.expiry,
    },
  };
}

/// Extract the human-readable claim facts from a NORMALIZED proof
/// (validateProofShape output): the extracted merged/author/repo/number the
/// contract's template check binds to the bounty. Returns
/// { ok, errors[], facts? }. Semantic verification still happens on-chain;
/// this only surfaces what the proof claims for display + preflight.
export function extractProofFacts(normalized) {
  const errors = [];
  const context = normalized?.claimInfo?.context;
  if (typeof context !== "string" || context.length === 0) {
    return { ok: false, errors: ["proof has no context to extract facts from"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(context);
  } catch {
    return { ok: false, errors: ["proof context is not valid JSON"] };
  }
  const ex = parsed?.extractedParameters;
  if (!ex || typeof ex !== "object") {
    return { ok: false, errors: ["proof context has no extractedParameters (was it generated with the required matchers?)"] };
  }
  for (const f of ["merged", "author", "repo", "number"]) {
    if (typeof ex[f] !== "string" || ex[f].length === 0) {
      errors.push(`proof is missing extracted '${f}'`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    facts: { merged: ex.merged, author: ex.author, repo: ex.repo, number: ex.number },
  };
}
