/* Prints the company-tier eval report: baseline and rules always, the model and the second look only from fresh recordings. Makes no model call.
     node scripts/eval-report.ts */
import { companyTierReport } from "../src/evals/report.ts";
console.log(companyTierReport());
