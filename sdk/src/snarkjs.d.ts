declare module "snarkjs" {
  export const groth16: {
    fullProve(input: object, wasm: unknown, zkey: unknown, logger?: unknown): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vk: object, publicSignals: string[], proof: object, logger?: unknown): Promise<boolean>;
  };
  export const zKey: any;
  export const wtns: any;
  export const powersOfTau: any;
}
