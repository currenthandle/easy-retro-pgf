import { z } from "zod";

export const VoteSchema = z.object({
  projectId: z.string(),
  amount: z.number().min(0),
});

export const BallotSchema = z.object({
  votes: z.array(VoteSchema),
});

export const BallotPublishSchema = z.object({
  chainId: z.number(),
  signature: z.custom<`0x${string}`>(),
  message: z.object({
    total_votes: z.bigint(),
    project_count: z.bigint(),
    hashed_votes: z.string(),
  }),
  kzgSignature: z.custom<`0x${string}`>(),
  kzgMessage: z.object({
    kzg_commitment: z.string(),
    // kzg_commitment: z.custom<`(0x${string},0x${string})`>(),
  }),
});

export type Vote = z.infer<typeof VoteSchema>;
export type Ballot = z.infer<typeof BallotSchema>;
export type BallotPublish = z.infer<typeof BallotPublishSchema>;
