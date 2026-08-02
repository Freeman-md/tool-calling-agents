import {
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth";


type StoredCalendlyAuth = {
    clientInformation?: OAuthClientInformationFull;
    tokens?: OAuthTokens;
    codeVerifier?: string;
};

export class CalendlyOAuthProvider implements OAuthClientProvider {
    public constructor(
        private readonly callbackUrl: string,
        private readonly authFilePath: string,
    ) { }

    public get redirectUrl(): string {
        return this.callbackUrl;
    }

    public get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: "Freeman Tool Calling Lab",
            redirect_uris: [
                this.callbackUrl
            ],
            grant_types: [
                "authorization_code",
            ],
            response_types: [
                "code",
            ],
            token_endpoint_auth_method: "none"
        }
    }

    public async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
        const auth = await this.readAuth()

        return auth.clientInformation;
    }

    public async saveClientInformation(
        clientInformation:
            OAuthClientInformationFull,
    ): Promise<void> {
        const auth = await this.readAuth();

        await this.writeAuth({
            ...auth,
            clientInformation,
        });
    }

    public async tokens():
        Promise<OAuthTokens | undefined> {
        const auth = await this.readAuth();

        return auth.tokens;
    }

    public async saveTokens(
        tokens: OAuthTokens,
    ): Promise<void> {
        const auth = await this.readAuth();

        await this.writeAuth({
            ...auth,
            tokens,
        });
    }

    public async codeVerifier():
        Promise<string> {
        const auth = await this.readAuth();

        if (!auth.codeVerifier) {
            throw new Error(
                "Calendly PKCE verifier is missing.",
            );
        }

        return auth.codeVerifier;
    }

    public async saveCodeVerifier(
        codeVerifier: string,
    ): Promise<void> {
        const auth = await this.readAuth();

        await this.writeAuth({
            ...auth,
            codeVerifier,
        });
    }

    public async redirectToAuthorization(
        authorizationUrl: URL,
    ): Promise<void> {
        console.log(
            "\nOpening Calendly authorization...",
        );

        console.log(
            authorizationUrl.toString(),
        );

        await open(
            authorizationUrl.toString(),
        );
    }

    private async readAuth():
        Promise<StoredCalendlyAuth> {
        try {
            const content = await readFile(
                this.authFilePath,
                "utf8",
            );

            return JSON.parse(
                content,
            ) as StoredCalendlyAuth;
        } catch (error) {
            const code =
                error instanceof Error &&
                    "code" in error
                    ? error.code
                    : undefined;

            if (code === "ENOENT") {
                return {};
            }

            throw error;
        }
    }

    private async writeAuth(
        auth: StoredCalendlyAuth,
    ): Promise<void> {
        const directory =
            dirname(this.authFilePath);

        const temporaryPath =
            `${this.authFilePath}.tmp`;

        await mkdir(directory, {
            recursive: true,
        });

        await writeFile(
            temporaryPath,
            JSON.stringify(auth, null, 2),
            {
                encoding: "utf8",
                mode: 0o600,
            },
        );

        await rename(
            temporaryPath,
            this.authFilePath,
        );
    }
}