import { z } from "zod";

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const projectIdSchema = z.string().uuid();
export const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const imageSchema = z
  .string()
  .max(512)
  .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), image: imageSchema }).strict(),
  z
    .object({
      type: z.literal("git"),
      repository: z
        .string()
        .regex(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
]);
const httpService = z
  .object({
    type: z.enum(["web", "nextjs"]),
    source: sourceSchema,
    runtime: z
      .object({
        port: z.number().int().min(1024).max(65535),
        healthPath: z
          .string()
          .max(200)
          .regex(/^\/[a-zA-Z0-9/_-]*$/)
          .default("/"),
      })
      .strict(),
    domains: z.array(domainSchema).max(10).default([]),
    resources: z
      .object({
        memoryMb: z.number().int().min(64).max(8192).default(512),
        cpus: z.number().min(0.1).max(8).default(1),
      })
      .strict()
      .default({ memoryMb: 512, cpus: 1 }),
  })
  .strict();
const postgresService = z
  .object({
    type: z.literal("postgres"),
    version: z.literal("17"),
    image: imageSchema.refine(
      (v) => v.startsWith("postgres:17@sha256:"),
      "Use a digest-pinned official postgres:17 image",
    ),
  })
  .strict();
export const applicationSpecSchema = z
  .object({
    apiVersion: z.literal("hotspark.dev/v1"),
    kind: z.literal("Application"),
    metadata: z.object({ name: nameSchema }).strict(),
    services: z
      .record(nameSchema, z.union([httpService, postgresService]))
      .refine(
        (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 20,
        "Provide 1–20 services",
      ),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const domains = Object.values(spec.services).flatMap((s) =>
      "domains" in s ? s.domains : [],
    );
    if (new Set(domains).size !== domains.length)
      ctx.addIssue({
        code: "custom",
        message: "Domains must be unique within an application",
      });
  });
export type ApplicationSpec = z.infer<typeof applicationSpecSchema>;
export const operationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("deploy"),
      projectId: projectIdSchema,
      deploymentId: z.string().uuid(),
      spec: applicationSpecSchema,
    })
    .strict(),
  ...(["start", "stop", "inspect"] as const).map((operation) =>
    z
      .object({ operation: z.literal(operation), projectId: projectIdSchema })
      .strict(),
  ),
]);
export type AgentOperation = z.infer<typeof operationSchema>;
export const applicationSpecJsonSchema = z.toJSONSchema(applicationSpecSchema, {
  target: "draft-7",
  io: "input",
});

export interface DeploymentPlan {
  version: 1;
  projectId: string;
  composeProject: string;
  spec: ApplicationSpec;
  builds: {
    service: string;
    repository: string;
    commit: string;
    image: string;
  }[];
}
export function planDeployment(
  projectId: string,
  input: unknown,
): DeploymentPlan {
  projectIdSchema.parse(projectId);
  const spec = applicationSpecSchema.parse(input);
  const composeProject = `hs-${projectId}`;
  return {
    version: 1,
    projectId,
    composeProject,
    spec,
    builds: Object.entries(spec.services).flatMap(([service, s]) =>
      s.type !== "postgres" && s.source.type === "git"
        ? [
            {
              service,
              repository: s.source.repository,
              commit: s.source.commit,
              image: `hotspark/${projectId}/${service}:${s.source.commit}`,
            },
          ]
        : [],
    ),
  };
}
