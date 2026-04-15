import { currentUser } from "@clerk/nextjs/server";
import { db } from "./prisma";

export const checkUser = async () => {
  const user = await currentUser();

  if (!user) {
    return null;
  }

  try {
    const email = user.emailAddresses?.[0]?.emailAddress;
    if (!email) {
      console.error("Missing email for authenticated Clerk user", {
        clerkUserId: user.id,
      });
      return null;
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

    const syncedUser = await db.user.upsert({
      where: {
        clerkUserId: user.id,
      },
      update: {
        email,
        name: name || null,
        imageUrl: user.imageUrl || null,
      },
      create: {
        clerkUserId: user.id,
        email,
        name: name || null,
        imageUrl: user.imageUrl || null,
      },
    });

    return syncedUser;
  } catch (error) {
    console.error("checkUser failed", error);
    return null;
  }
};
