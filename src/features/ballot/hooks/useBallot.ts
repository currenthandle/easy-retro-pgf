import { useMutation } from "@tanstack/react-query";
import { useBeforeUnload } from "react-use";
import { useAccount, useChainId, useSignTypedData } from "wagmi";
import type { Vote, Ballot } from "~/features/ballot/types";

import { ballotTypedData, kzgTypedData } from "~/utils/typedData";
import { api } from "~/utils/api";
import { useSession } from "next-auth/react";
import { keccak256 } from "viem";
import { useSearchProjects } from "~/features/projects/hooks/useProjects";
import { z } from "zod";

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

        const input_arr = Array.from(projectMap.values())

        // TODO: we'll need the actual number of projects
        // it will need to coorespond to the number of 
        // projects in the zk circuit on Lilith
        while (input_arr.length < 10) {
          input_arr.push(-1);
        }

        const inputJson = {
          input_data: [input_arr],
        };

        const inputJsonString = JSON.stringify(inputJson);

        console.log("inputJsonString", inputJsonString);

        const kszResp = await createKzgCommitment(inputJson);

        const recipe_id = kszResp.id;

        const kzg_commitment = await fetchKzgCommitment(recipe_id);

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
          kzg_commitment,
          // kzg_commitment: "(0x1234, 0x5678)" as const,
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

function little_endian(proof: number[], bytes: number) {
  let result = "";
  for (let i = 0; i < bytes; i++) {
    result = proof[i]?.toString(16) + result;
  }
  return `0x${result}` as const;
}

async function fetchKzgCommitment(id: string) {
  const archon = {
    API_KEY: "2fc6ec8d-c492-47f9-97ce-a80603dbfe4b",
    ARCHON_URL: "https://archon-v0.ezkl.xyz",
  };

  const headers = {
    "X-API-KEY": archon.API_KEY,
    "Content-Type": "application/json",
    accept: "*/*",
  };

  const req_url = `${archon.ARCHON_URL}/recipe/${id}?indices=1`;

  try {
    const response = await fetch(req_url, {
      method: "GET",
      headers,
    });
    const response_data_schema = z
      .array(
        z.object({
          output: z.string(),
        }),
      )
      .nonempty();

    const json_raw = (await response.json()) as unknown;
    const json = response_data_schema.parse(json_raw);

    const output_str = json[0].output;
    const output_raw = JSON.parse(output_str) as unknown;

    const output_schema = z.object({
      proof: z.array(z.number()),
    });
    const output = output_schema.parse(output_raw);

    const proof = output.proof;

    const kzg_commitment = little_endian(proof, 64);

    return kzg_commitment;
  } catch (error) {
    console.error("Error fetching KZG commitment", error);
    throw error;
  }
}

async function createKzgCommitment(input: { input_data: number[][] }) {
  const archon = {
    // API_KEY: process.env.ARCHON_KEY!,
    // ARCHON_URL: process.env.ARCHON_URL!,
    ARCHON_KEY: "2fc6ec8d-c492-47f9-97ce-a80603dbfe4b" as const,
    ARCHON_URL: "https://archon-v0.ezkl.xyz" as const,
  };
  const headers = {
    "X-API-KEY": archon.ARCHON_KEY,
    "Content-Type": "application/json" as const,
    accept: "*/*" as const,
  };

  const commands = [
    {
      ezkl_command: {
        GenWitness: {
          data: "input.json",
          compiled_circuit: "model.compiled",
          output: "witness.json",
        },
      },
      working_dir: "votes-small",
    },
    {
      ezkl_command: {
        Prove: {
          witness: "witness.json",
          compiled_circuit: "model.compiled",
          pk_path: "pk.key",
          proof_path: "proof.json",
          proof_type: "Single",
          check_mode: "UNSAFE",
        },
      },
      working_dir: "votes-small",
    },
  ];

  const body = JSON.stringify({
    commands,
    data: [input],
  });

  try {
    const response = await fetch(`${archon.ARCHON_URL}/recipe`, {
      method: "POST",
      headers,
      body,
      // body: '{"commands":[{"ezkl_command":{"GenWitness":{"data":"input.json","compiled_circuit":"model.compiled","output":"witness.json"}},"working_dir":"votes-small"},{"ezkl_command":{"Prove":{"witness":"witness.json","compiled_circuit":"model.compiled","pk_path":"pk.key","proof_path":"proof.json","proof_type":"Single","check_mode":"UNSAFE"}},"working_dir":"votes-small"}],"data":[{"input_data":[[11,-1,-1,-1,-1,-1,-1,-1,-1,-1]]}]}'
    });

    const json: unknown = await response.json();

    const response_schema = z.object({
      id: z.string(),
      was_already_scheduled: z.boolean(),
    });

    const data = response_schema.parse(json);

    console.log("data", data);
    return data;
  } catch (error) {
    console.error("Error fetching KZG commitment", error);
    throw error;
  }
}
