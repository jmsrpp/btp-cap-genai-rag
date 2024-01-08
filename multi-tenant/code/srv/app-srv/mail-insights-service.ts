import cds from "@sap/cds";
import { Request } from "@sap/cds/apis/events";

import CommonMailInsights from "../common/handlers/common-mail-insights";
import * as aiCore from "../common/utils/ai-core"; 
import { TypeORMVectorStoreDocument } from "langchain/vectorstores/typeorm";

/**
 * MailInsightsService class extends CommonMailInsights
 * @extends CommonMailInsights
 */
export default class MailInsightsService extends CommonMailInsights {
    /**
     * Initialization method to register CAP Action Handlers
     * @async
     * @returns {Promise<void>}
     */
    async init() {
        // Shared handlers (getMails, getMail, addMails, deleteMail)
        await super.init();

        // Create a default SAP AI Core resource groups if non existent
        await aiCore.checkDefaultResourceGroup();

        // Additional handlers
        this.on("submitResponse", this.onSubmitResponse);
        this.on("revokeResponse", this.onRevokeResponse);
        this.on("regenerateInsights", this.onRegenerateInsights);
        this.on("regenerateResponse", this.onRegenerateResponse);
        this.on("translateResponse", this.onTranslateResponse);
        this.on("findMails", this.onFindMails);

    }

    /**
     * Method to regenerate Insights for all available Mails
     * @async
     * @param {Request} req - Request object
     * @returns {Promise<boolean|*>}
     */
    private onRegenerateInsights = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { rag } = req.data;
            const { Mails } = this.entities;
            const mails = await SELECT.from(Mails);
            const mailBatch = await this.regenerateInsights(mails, rag, tenant);

            // insert mails with insights
            console.log("UPDATE MAILS WITH INSIGHTS...");

            cds.tx(async () => {
                const { Mails } = this.entities;
                await UPSERT.into(Mails).entries(mailBatch);
            });

            return true;
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };

    /**
     * Method to regenerate Response for a single Mail
     * @async
     * @param {Request} req - Request object
     * @returns {Promise<boolean|*>}
     */
    private onRegenerateResponse = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { id, selectedMails, additionalInformation } = req.data;
            const { Mails } = this.entities;
            const mail = await SELECT.one.from(Mails, id);
            const response = await this.regenerateResponse(mail, selectedMails, tenant, additionalInformation);
            await UPDATE.entity(Mails).where(`ID = '${id}'`).set(response);
            return true;
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };

    /**
     * Method to translate Response to original e-mail language
     * @async
     * @param {Request} req - Request object
     * @returns {Promise<boolean|*>}
     */
    private onTranslateResponse = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { id, response } = req.data;
            const { Mails } = this.entities;
            const mail = await SELECT.one.from(Mails, id);
            const translation = (await this.translateResponse(response, tenant, mail.languageNameDetermined))
                .responseBody;
            return translation;
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };

    private onFindMails = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { searchKeywordSimilarMails, id } = req.data;
            const { Mails } = this.entities;

            const foundEmailsSimilaritiesIDs = await this.getFoundMail(id, searchKeywordSimilarMails, tenant)

            const foundEmails =
                foundEmailsSimilaritiesIDs.length > 0
                    ? await SELECT.from(Mails, (m: any) => {
                          m.ID;
                          m.subject;
                          m.body;
                          m.category;
                          m.sender;
                          m.responded;
                          m.responseBody;
                          m.translation((t: any) => {
                              t`.*`;
                          });
                      }).where({
                          ID: {
                              in: foundEmailsSimilaritiesIDs.map(
                                  ([doc, _distance]: [TypeORMVectorStoreDocument, number]) => doc.metadata.id
                              )
                          }
                      })
                    : [];

            const foundEmailsWithSimilarity: { similarity: number; mail: any } = foundEmails.map((mail: any) => {
                //@ts-ignore
                const [_, _distance]: [TypeORMVectorStoreDocument, number] = foundEmailsSimilaritiesIDs.find(
                    ([doc, _distance]: [TypeORMVectorStoreDocument, number]) => mail.ID === doc.metadata.id
                );
                return { similarity: 1.0 - _distance, mail: mail };
            });

            return foundEmailsWithSimilarity
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };

    /**
     * Method to submit response for a single Mail. Response always passed in user's working language
     * @async
     * @param {Request} req - Request object
     * @returns {Promise<boolean|*>}
     */
    private onSubmitResponse = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { id, response } = req.data;
            const { Mails } = this.entities;
            const mail = await SELECT.one.from(Mails, id).columns((m: any) => {
                m("*");
                m.translation((t: any) => t("*"));
            });

            // Translate working language response to recipient's original language
            const translation =
                mail.languageMatch === undefined || mail.languageMatch
                    ? response
                    : (await this.translateResponse(response, tenant, mail.languageNameDetermined)).responseBody;

            // Implement your custom logic to send e-mail e.g. using Microsoft Graph API
            // Send the working language response + target language translation + AI Translation Disclaimer;
            const submittedMail = {
                ...mail,
                responded: true,
                responseBody: translation,
                translation: { ...mail.translation, responseBody: response }
            };
            const success = await UPDATE(Mails, mail.ID).set(submittedMail);
            if (success) {
                const typeormVectorStore = await this.getVectorStore(tenant);
                const submitQueryPGVector = `UPDATE ${typeormVectorStore.tableName} SET metadata = metadata::jsonb || '{"submitted": true}' where (metadata->'id')::jsonb ? $1`;
                await typeormVectorStore.appDataSource.query(submitQueryPGVector, [id]);
            }
            return new Boolean(success);
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };


    /**
     * Method to revoke responded status for a single mail
     * @async
     * @param {Request} req - Request object
     * @returns {Promise<boolean|*>}
     */
    private onRevokeResponse = async (req: Request) => {
        try {
            const tenant = cds.env?.requires?.multitenancy && req.tenant;
            const { id } = req.data;
            const { Mails } = this.entities;

            const success = await UPDATE(Mails, id).with({responded : false});

            if (success) {
                const typeormVectorStore = await this.getVectorStore(tenant);
                const submitQueryPGVector = `UPDATE ${typeormVectorStore.tableName} SET metadata = metadata::jsonb || '{"submitted": false}' where (metadata->'id')::jsonb ? $1`;
                await typeormVectorStore.appDataSource.query(submitQueryPGVector, [id]);
            }

            return new Boolean(success);
        } catch (error: any) {
            console.error(`Error: ${error?.message}`);
            return req.error(`Error: ${error?.message}`);
        }
    };
}