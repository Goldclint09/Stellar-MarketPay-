"use strict";

const pool = require("../db/pool");

/**
 * Platform-wide unified search across jobs, freelancers, and DAO proposals
 * using PostgreSQL full-text search (tsvector).
 *
 * @param {string} query - Search query string
 * @param {number} [limit=5] - Maximum items to return per entity type
 * @returns {Promise<{ jobs: Array, freelancers: Array, proposals: Array }>}
 */
const SEARCH_TYPES = ["jobs", "freelancers", "proposals"];

function decodeCursor(cursor) {
  if (cursor == null || cursor === "") {
    return { jobs: 0, freelancers: 0, proposals: 0 };
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || SEARCH_TYPES.some((type) =>
      !(type in decoded) ||
      (decoded[type] !== null && (!Number.isSafeInteger(decoded[type]) || decoded[type] < 0 || decoded[type] > 1_000_000))
    )) {
      throw new Error("invalid cursor state");
    }
    return Object.fromEntries(SEARCH_TYPES.map((type) => [type, decoded[type]]));
  } catch {
    const error = new Error("cursor must be a valid search cursor");
    error.status = 400;
    throw error;
  }
}

function encodeCursor(offsets) {
  return Buffer.from(JSON.stringify(offsets), "utf8").toString("base64url");
}

async function searchAll(query, limit = 5, cursor) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return { jobs: [], freelancers: [], proposals: [] };
  }

  const cleanQuery = query.trim();
  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), 20)
    : 5;
  const offsets = decodeCursor(cursor);

  const [jobsRes, freelancersRes, proposalsRes] = await Promise.allSettled([
    offsets.jobs === null ? [] : searchJobs(cleanQuery, safeLimit + 1, offsets.jobs),
    offsets.freelancers === null ? [] : searchFreelancers(cleanQuery, safeLimit + 1, offsets.freelancers),
    offsets.proposals === null ? [] : searchProposals(cleanQuery, safeLimit + 1, offsets.proposals),
  ]);

  const results = {
    jobs: jobsRes.status === "fulfilled" ? jobsRes.value : [],
    freelancers:
      freelancersRes.status === "fulfilled" ? freelancersRes.value : [],
    proposals: proposalsRes.status === "fulfilled" ? proposalsRes.value : [],
  };

  const nextOffsets = {};
  for (const type of SEARCH_TYPES) {
    const hasMore = results[type].length > safeLimit;
    results[type] = results[type].slice(0, safeLimit);
    const nextOffset = offsets[type] + safeLimit;
    nextOffsets[type] = hasMore && nextOffset <= 1_000_000 ? nextOffset : null;
  }

  return {
    ...results,
    pagination: {
      limit: safeLimit,
      nextCursor: SEARCH_TYPES.some((type) => nextOffsets[type] !== null)
        ? encodeCursor(nextOffsets)
        : null,
    },
  };
}

async function searchJobs(query, limit, offset = 0) {
  const sql = `
    SELECT 
      id,
      title,
      description,
      budget,
      currency,
      category,
      status,
      client_address AS "clientAddress",
      created_at AS "createdAt",
      ts_rank(
        COALESCE(search_vector, to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, ''))),
        plainto_tsquery('english', $1)
      ) AS rank
    FROM jobs
    WHERE 
      deleted_at IS NULL
      AND COALESCE(search_vector, to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, ''))) @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, created_at DESC, id DESC
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(sql, [query, limit, offset]);
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    description: r.description,
    budget: r.budget,
    currency: r.currency,
    category: r.category,
    status: r.status,
    clientAddress: r.clientAddress,
    createdAt: r.createdAt,
    rank: parseFloat(r.rank) || 0,
  }));
}

async function searchFreelancers(query, limit, offset = 0) {
  const sql = `
    SELECT 
      public_key AS "publicKey",
      display_name AS "displayName",
      bio,
      skills,
      rating,
      completed_jobs AS "completedJobs",
      role,
      created_at AS "createdAt",
      ts_rank(
        to_tsvector('english', COALESCE(display_name, '') || ' ' || COALESCE(bio, '') || ' ' || COALESCE(public_key, '') || ' ' || COALESCE(array_to_string(skills, ' '), '')),
        plainto_tsquery('english', $1)
      ) AS rank
    FROM profiles
    WHERE 
      (deletion_status IS NULL OR deletion_status = 'active')
      AND role IN ('freelancer', 'both')
      AND to_tsvector('english', COALESCE(display_name, '') || ' ' || COALESCE(bio, '') || ' ' || COALESCE(public_key, '') || ' ' || COALESCE(array_to_string(skills, ' '), '')) @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, rating DESC NULLS LAST, completed_jobs DESC, public_key ASC
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(sql, [query, limit, offset]);
  return rows.map((r) => ({
    publicKey: r.publicKey,
    displayName: r.displayName || r.publicKey,
    bio: r.bio || "",
    skills: Array.isArray(r.skills) ? r.skills : [],
    rating: r.rating != null ? parseFloat(r.rating) : null,
    completedJobs: r.completedJobs || 0,
    role: r.role,
    createdAt: r.createdAt,
    rank: parseFloat(r.rank) || 0,
  }));
}

async function searchProposals(query, limit, offset = 0) {
  const sql = `
    SELECT 
      id,
      title,
      description,
      type,
      proposer,
      amount,
      recipient,
      status,
      voting_ends_at AS "votingEndsAt",
      created_at AS "createdAt",
      ts_rank(
        to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '')),
        plainto_tsquery('english', $1)
      ) AS rank
    FROM dao_proposals
    WHERE 
      to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, created_at DESC, id DESC
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(sql, [query, limit, offset]);
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    description: r.description,
    type: r.type,
    proposer: r.proposer,
    amount: r.amount,
    recipient: r.recipient,
    status: r.status,
    votingEndsAt: r.votingEndsAt,
    createdAt: r.createdAt,
    rank: parseFloat(r.rank) || 0,
  }));
}

module.exports = {
  searchAll,
  searchJobs,
  searchFreelancers,
  searchProposals,
  encodeCursor,
  decodeCursor,
};
