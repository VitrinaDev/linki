import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  return res.status(410).json({
    error: "Cookie import is disabled. Authenticate through the proxy-bound server login.",
  });
}
