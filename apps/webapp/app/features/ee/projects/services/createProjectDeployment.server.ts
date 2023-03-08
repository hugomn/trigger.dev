import type {
  RepositoryProject,
  RuntimeEnvironment,
  ProjectDeployment,
} from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { cakework } from "../cakework.server";
import { taskQueue } from "~/services/messageBroker.server";
import type { GitHubAppAuthorizationWithValidToken } from "../github/refreshInstallationAccessToken.server";
import type { GitHubCommit } from "../github/githubApp.server";
import { getNextDeploymentVersion } from "../models/repositoryProject.server";

export type CreateProjectDeploymentOptions = {
  project: RepositoryProject;
  authorization: GitHubAppAuthorizationWithValidToken;
  environment: RuntimeEnvironment;
  commit: GitHubCommit;
};

export class CreateProjectDeployment {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    {
      project,
      environment,
      authorization,
      commit,
    }: CreateProjectDeploymentOptions,
    retryCount = 0
  ): Promise<ProjectDeployment | undefined> {
    const version = await getNextDeploymentVersion(project.id);

    const dockerfile = formatFileContents(`
      FROM node:18-bullseye-slim
      WORKDIR /app
      COPY package*.json ./
      RUN ${project.buildCommand}
      COPY . .
      CMD [${project.startCommand
        .split(" ")
        .map((s) => `"${s}"`)
        .join(", ")}]
    `);

    const dockerIgnore = formatFileContents(`
      node_modules
    `);

    console.log(
      `[${version}][attempt=${retryCount + 1}] Building image for ${
        project.name
      } with token ${authorization.installationAccessToken}`
    );

    const build = await cakework.buildImageFromGithub({
      dockerfile: dockerfile,
      dockerignore: dockerIgnore,
      token: authorization.installationAccessToken,
      repository: project.name,
      branch: project.branch,
    });

    console.log(
      `[${version}][attempt=${retryCount + 1}] Build started for ${
        project.name
      } with id ${build.buildId}`
    );

    try {
      // Create the deployment
      // Setting the buildStartAt because even though this is a PENDING deployment,
      // we have already started to build it with Cakework (it can still end up not getting deployed if this deployment is cancelled)
      const deployment = await this.#prismaClient.projectDeployment.create({
        data: {
          version,
          buildId: build.buildId,
          buildStartedAt: new Date(),
          project: {
            connect: {
              id: project.id,
            },
          },
          environment: {
            connect: {
              id: environment.id,
            },
          },
          status: "PENDING",
          branch: project.branch,
          commitHash: commit.sha,
          commitMessage: commit.commit.message,
          committer: getCommitAuthor(commit),
          dockerfile,
          dockerIgnore,
        },
      });

      await taskQueue.publish("PROJECT_DEPLOYMENT_CREATED", {
        id: deployment.id,
      });

      return deployment;
    } catch (error) {
      console.error(
        `[${version}] Error creating deployment for ${project.name}: ${error}`
      );

      if (typeof error === "object" && error !== null) {
        if ("code" in error && error.code === "P2002") {
          if (retryCount > 3) {
            return;
          }
          // If the deployment version already exists, then we should retry
          return await this.call(
            {
              project,
              environment,
              authorization,
              commit,
            },
            retryCount + 1
          );
        }
      }

      throw error;
    }
  }
}

function getCommitAuthor(commit: GitHubCommit) {
  if (commit.commit.author && commit.commit.author.name) {
    return commit.commit.author.name;
  }

  if (commit.committer && commit.committer.login) {
    return commit.committer.login;
  }

  if (commit.author && commit.author.login) {
    return commit.author.login;
  }

  return "Unknown";
}

// Remove newlines at the beginning of the file, and remove any leading whitespace on each line (make sure not to remove any other whitespace)
// For example, the following input:
//
//      FROM node:bullseye-slim
//      WORKDIR /app
//      COPY package*.json ./
//      RUN npm install && npm run build
//      COPY . .
//      CMD ["node", "dist/index.js"]
//
// Would be formatted to:
// FROM node:bullseye-slim
// WORKDIR /app
// COPY package*.json ./
// RUN npm install && npm run build
// COPY . .
// CMD ["node", "dist/index.js"]
function formatFileContents(contents: string) {
  return contents
    .trimStart()
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}