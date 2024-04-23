export const ballotTypedData = (chainId?: number) =>
  ({
    primaryType: "Ballot",
    domain: {
      name: "Sign votes",
      version: "1",
      chainId,
    },
    types: {
      Ballot: [
        { name: "total_votes", type: "uint256" },
        { name: "project_count", type: "uint256" },
        { name: "hashed_votes", type: "string" },
      ],
    },
  }) as const;


export const kzgTypedData = (chainId?: number) =>
  ({
    primaryType: "KzgCommitment",
    domain: {
      name: "Signed KZG Commitment",
      version: "1",
      chainId,
    },
    types: {
      KzgCommitment: [
        { name: "kzg_commitment", type: "string" },
      ],
    },
  }) as const;
