import { useMutation } from "@tanstack/react-query";
import { useBeforeUnload } from "react-use";
import { useAccount, useChainId, useSignTypedData } from "wagmi";
import type { Vote, Ballot } from "~/features/ballot/types";

import { ballotTypedData, kzgTypedData } from "~/utils/typedData";
import { api } from "~/utils/api";
import { useSession } from "next-auth/react";
import { keccak256 } from "viem";
import { useSearchProjects } from "~/features/projects/hooks/useProjects";

export function useSaveBallot(opts?: { onSuccess?: () => void }) {
  const utils = api.useUtils();

  const save = api.ballot.save.useMutation({
    onSuccess: () => {
      // Refetch the ballot to update the UI
      utils.ballot.invalidate().catch(console.log);
      opts?.onSuccess?.();
    },
  });
  useBeforeUnload(save.isPending, "You have unsaved changes, are you sure?");

  return save;
}

export function useAddToBallot() {
  const { data: ballot } = useBallot();
  const { mutate } = useSaveBallot();

  return useMutation({
    mutationFn: async (votes: Vote[]) => {
      if (ballot) {
        return mutate(mergeBallot(ballot as unknown as Ballot, votes));
      }
    },
  });
}

export function useRemoveFromBallot() {
  const { data: ballot } = useBallot();

  const { mutate } = useSaveBallot();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const votes = (ballot?.votes ?? []).filter(
        (v) => v.projectId !== projectId,
      );
      return mutate({ ...ballot, votes });
    },
  });
}

export function useBallot() {
  const { address } = useAccount();
  const { data: session } = useSession();
  return api.ballot.get.useQuery(undefined, {
    enabled: Boolean(address && session),
  });
}

export function useSubmitBallot({
  onSuccess,
}: {
  onSuccess: () => Promise<void>;
}) {
  const chainId = useChainId();
  const { refetch } = useBallot();
  const { mutateAsync, isPending } = api.ballot.publish.useMutation({
    onSuccess,
  });
  const projects = useSearchProjects();

  if (!projects?.data?.pages) {
    return;
  }

  const projectMap = new Map<string, number>();
  const projectIds = projects?.data?.pages
    .flat()
    .map((project) => project.id)
    .sort();

  projectIds.forEach((id) => {
    projectMap.set(id, -1);
  });

  // console.log("projectIDs", projectIds);

  useBeforeUnload(isPending, "You have unsaved changes, are you sure?");

  const { signTypedDataAsync } = useSignTypedData();

  return useMutation({
    mutationFn: async () => {
      if (chainId) {
        const { data: ballot } = await refetch();
        // console.log("votes", ballot?.votes);

        ballot?.votes.forEach((vote) =>
          projectMap.set(vote.projectId, vote.amount),
        );

        console.log("projectMap", projectMap);
        console.log("projectIds", projectIds);

        const inputJson = {
          input_data: Array.from(projectMap.values()),
        };

        const inputJsonString = JSON.stringify(inputJson);

        console.log("inputJsonString", inputJsonString);

        const message = {
          total_votes: BigInt(sumBallot(ballot?.votes)),
          project_count: BigInt(ballot?.votes?.length ?? 0),
          hashed_votes: keccak256(Buffer.from(JSON.stringify(ballot?.votes))),
        };
        const signature = await signTypedDataAsync({
          ...ballotTypedData(chainId),
          message,
        });

        const kzgMessage = {
          kzg_commitment: "(0x1234, 0x5678)" as const,
        };

        const kzgSignature = await signTypedDataAsync({
          ...kzgTypedData(chainId),
          message: kzgMessage,
        });

        /*
          TODO: create addtional signature
          const kzgCommitment = call_lilith(inputJson: string) => kzgCommitment: string 
          const kzgMessage = {
            kzgCommitment: kzgCommitment
          }

        */

        return mutateAsync({
          signature,
          kzgSignature,
          message,
          kzgMessage,
          chainId,
        });
      }
    },
  });
}

export const sumBallot = (votes?: Vote[]) =>
  (votes ?? []).reduce(
    (sum, x) => sum + (!isNaN(Number(x?.amount)) ? Number(x.amount) : 0),
    0,
  );

export function ballotContains(id: string, ballot?: Ballot) {
  return ballot?.votes.find((v) => v.projectId === id);
}

function mergeBallot(ballot: Ballot, addedVotes: Vote[]) {
  return {
    ...ballot,
    votes: Object.values<Vote>({
      ...toObject(ballot?.votes, "projectId"),
      ...toObject(addedVotes, "projectId"),
    }),
  };
}

function toObject(arr: object[] = [], key: string) {
  return arr?.reduce(
    (acc, x) => ({ ...acc, [x[key as keyof typeof acc]]: x }),
    {},
  );
}
