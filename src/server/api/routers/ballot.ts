import { TRPCError } from "@trpc/server";
import { type Address, verifyTypedData, keccak256 } from "viem";
import { isAfter } from "date-fns";
import {
  type BallotPublish,
  BallotPublishSchema,
  BallotSchema,
  type Vote,
} from "~/features/ballot/types";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ballotTypedData } from "~/utils/typedData";
import type { db } from "~/server/db";
import { config, eas } from "~/config";
import { sumBallot } from "~/features/ballot/hooks/useBallot";
import { type Prisma } from "@prisma/client";
import { fetchApprovedVoter } from "~/utils/fetchAttestations";
import engine from "~/ezkl/engine";
import fs from "fs";
import path from "path";
import { fetchAttestations, createDataFilter } from "~/utils/fetchAttestations";

// console.log('path', __dirname);
// const vk = fs.readFileSync("~/src/ezkl/artifacts/vk.key");
//
// console.log("vk", vk);
// const vkPath = path.join(__dirname, "../../../../src/ezkl/artifacts/vk.key");
const rootDir = path.resolve(__dirname, "../../../../../"); // Adjust this as necessary
const vkPath = path.join(rootDir, "src/ezkl/artifacts/vk.key");
const settingsPath = path.join(rootDir, "src/ezkl/artifacts/settings.json");
const srsPath = path.join(rootDir, "src/ezkl/artifacts/kzg25.srs");

let vk: Uint8ClampedArray;
let settings: Uint8ClampedArray;
let srs: Uint8ClampedArray;

try {
  const vkBuf = fs.readFileSync(vkPath);
  const settingsBuf = fs.readFileSync(settingsPath);
  const srsBuf = fs.readFileSync(srsPath);

  vk = new Uint8ClampedArray(vkBuf);
  settings = new Uint8ClampedArray(settingsBuf);
  srs = new Uint8ClampedArray(srsBuf);

  console.log("VK loaded successfully");
  console.log("VK", vk);
  console.log("Settings", settings);
  console.log("SRS", srs);
} catch (error) {
  console.log("VK Path", vkPath);
  console.error("Error loading the VK:", error);
}

const defaultBallotSelect = {
  votes: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  signature: true,
  kzgCommitment: true,
} satisfies Prisma.BallotSelect;

export const ballotRouter = createTRPCRouter({
  get: protectedProcedure.query(({ ctx }) => {
    const voterId = ctx.session.user.name!;
    return ctx.db.ballot
      .findUnique({ select: defaultBallotSelect, where: { voterId } })
      .then((ballot) => ({
        ...ballot,
        votes: (ballot?.votes as Vote[]) ?? [],
      }));
  }),
  save: protectedProcedure
    .input(BallotSchema)
    .mutation(async ({ input, ctx }) => {
      const voterId = ctx.session.user.name!;
      if (isAfter(new Date(), config.votingEndsAt)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Voting has ended" });
      }
      await verifyUnpublishedBallot(voterId, ctx.db);

      const projectCount = await countApprovedProjects();

      // const kzgCommitment = createKZGCommitment(input.votes);
      const kzgCommitment = createKZGCommitment();

      console.log("==================================================");
      console.log("engine", engine);
      console.log("input", input);

      return ctx.db.ballot.upsert({
        select: defaultBallotSelect,
        where: { voterId },
        update: { ...input, kzgCommitment },
        create: { voterId, ...input, kzgCommitment },
      });

      function createKZGCommitment() {
        const message: Uint8ClampedArray = new Uint8ClampedArray(32);
        const commitment = engine.kzgCommit(message, vk, settings, srs);
        const commitmentStr = new TextDecoder().decode(commitment);
        return commitment;
      }

      async function countApprovedProjects() {
        return fetchAttestations([eas.schemas.approval], {
          where: {
            attester: { in: config.admins },
            AND: [
              createDataFilter("type", "bytes32", "application"),
              createDataFilter("round", "bytes32", config.roundId),
            ],
          },
        }).then((attestations = []) => {
          // Handle multiple approvals of an application - group by refUID
          return {
            count: Object.keys(
              attestations.reduce(
                (acc, x) => ({ ...acc, [x.refUID]: true }),
                {},
              ),
            ).length,
          };
        });
      }
    }),
  publish: protectedProcedure
    .input(BallotPublishSchema)
    .mutation(async ({ input, ctx }) => {
      const voterId = ctx.session.user.name!;

      if (isAfter(new Date(), config.votingEndsAt)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Voting has ended" });
      }

      const ballot = await verifyUnpublishedBallot(voterId, ctx.db);
      if (!ballot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ballot doesn't exist",
        });
      }

      if (!verifyBallotCount(ballot.votes as Vote[])) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Ballot must have a maximum of ${config.votingMaxTotal} votes and ${config.votingMaxProject} per project.`,
        });
      }

      if (!(await fetchApprovedVoter(voterId))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Voter is not approved",
        });
      }

      if (
        !(await verifyBallotHash(
          input.message.hashed_votes,
          ballot.votes as Vote[],
        ))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Votes hash mismatch",
        });
      }
      const { signature } = input;
      if (!(await verifyBallotSignature({ ...input, address: voterId }))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Signature couldn't be verified",
        });
      }

      return ctx.db.ballot.update({
        where: { voterId },
        data: { publishedAt: new Date(), signature },
      });
    }),
});

function verifyBallotCount(votes: Vote[]) {
  const sum = sumBallot(votes);
  const validVotes = votes.every(
    (vote) => vote.amount <= config.votingMaxProject,
  );
  return sum <= config.votingMaxTotal && validVotes;
}

async function verifyBallotHash(hashed_votes: string, votes: Vote[]) {
  return hashed_votes === keccak256(Buffer.from(JSON.stringify(votes)));
}
async function verifyUnpublishedBallot(voterId: string, { ballot }: typeof db) {
  const existing = await ballot.findUnique({
    select: defaultBallotSelect,
    where: { voterId },
  });

  // Can only be submitted once
  if (existing?.publishedAt) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Ballot already published",
    });
  }
  return existing;
}

async function verifyBallotSignature({
  address,
  signature,
  message,
  chainId,
}: { address: string } & BallotPublish) {
  return await verifyTypedData({
    ...ballotTypedData(chainId),
    address: address as Address,
    message,
    signature,
  });
}
