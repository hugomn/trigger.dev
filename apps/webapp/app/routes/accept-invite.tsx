import type { LoaderArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { getInviteFromToken } from "~/models/member.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { getUser } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  const user = await getUser(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invalid invite url. Please ask the person who invited you to send another invite."
    );
  }

  const invite = await getInviteFromToken({ token });
  if (!invite) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invite not found. Please ask the person who invited you to send another invite."
    );
  }

  if (!user) {
    return redirectWithSuccessMessage(
      "/",
      request,
      "Please login to accept the invite."
    );
  }

  if (invite.email !== user.email) {
    return redirectWithErrorMessage(
      "/",
      request,
      `This invite is for a different email address. This account is registered to ${user.email}.`
    );
  }

  return redirectWithSuccessMessage("/", request, "Invite retrieved");
}