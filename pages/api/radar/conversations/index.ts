import type { NextApiRequest, NextApiResponse } from "next";
import { managedClaimSchema,registerManagedClaim,requireRadarSecret,managedRetirementSchema,retireManagedScope } from "@/lib/radar/managed-conversations";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
/** Only Radar's server can register a claimed native thread. A Linki browser
 * session cannot widen Radar's managed scope. */
export default function handler(req:NextApiRequest,res:NextApiResponse) {
  if(req.method!=="POST" && req.method!=="DELETE"){res.setHeader("Allow","POST, DELETE");return res.status(405).json({error:"Method not allowed"});}
  try {requireRadarSecret(req.headers["x-internal-secret"]);
    if(req.method==="DELETE")return res.status(200).json(retireManagedScope(managedRetirementSchema.parse(req.body)));
    const input=managedClaimSchema.parse(req.body);
    const result=registerManagedClaim(input);if(process.env.LINKI_DISABLE_RUNNER!=="true")ensureGlobalRunnerStarted();return res.status(200).json(result);
  } catch(error) {return res.status((error as {statusCode?:number}).statusCode??400).json({error:"Managed thread registration rejected"});}
}
