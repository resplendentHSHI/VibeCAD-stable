import fetch, { RequestInit } from 'node-fetch';

const ONSHAPE_API_URL = process.env.ONSHAPE_API_URL || 'https://cad.onshape.com/api/v1';
const ONSHAPE_ACCESS_KEY = process.env.ONSHAPE_ACCESS_KEY;
const ONSHAPE_SECRET_KEY = process.env.ONSHAPE_SECRET_KEY;

if (!ONSHAPE_ACCESS_KEY || !ONSHAPE_SECRET_KEY) {
    console.error("Onshape API keys not set. Please set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY environment variables.");
    // In a real server, you might throw here or handle this differently.
    // For this example, we'll let it proceed but API calls will fail.
}

const authHeader = 'Basic ' + Buffer.from(`${ONSHAPE_ACCESS_KEY}:${ONSHAPE_SECRET_KEY}`).toString('base64');

export async function onshapeApiRequest(method: string, path: string, body?: any, queryParams?: URLSearchParams): Promise<any> {
    const url = `${ONSHAPE_API_URL}${path}${queryParams ? `?${queryParams.toString()}` : ''}`;
    //console.log(`Making Onshape API request: ${method} ${url}`);
    if (body) {
        //console.log("Request Body:", JSON.stringify(body, null, 2));
    }


    const options: RequestInit = {
        method: method,
        headers: {
            'accept' : 'application/json;charset=UTF-8; qs=0.09',
            'Authorization': authHeader,
            'Content-Type': 'application/json;charset=UTF-8; qs=0.09',
        },
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Onshape API Error: ${response.status} ${response.statusText} - ${errorBody}`);
        }
         // Check if response has content before parsing JSON
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (error) {
        console.error(`Error during Onshape API request to ${url}: ${error}`);
        throw error; // Re-throw to be caught by the MCP tool handler
    }
}

// Helper to find the default workspace for a document
export async function getDefaultWorkspace(documentId: string): Promise<string | undefined> {
    try {
        const docInfo = await onshapeApiRequest('GET', `/documents/${documentId}`);
        return docInfo.defaultWorkspace?.id;
    } catch (error) {
        console.error(`Failed to get default workspace for document ${documentId}: ${error}`);
        return undefined;
    }
}

// Helper to find a Part Studio element by name (simplified)
export async function findPartStudioByName(documentId: string, workspaceId: string, name: string): Promise<any | undefined> {
    try {
        const queryParams = new URLSearchParams({
            elementType: 'PARTSTUDIO'
        });
        const elements = await onshapeApiRequest(
            'GET',
            `/documents/d/${documentId}/w/${workspaceId}/elements`,
             undefined,
             queryParams
        );
        return elements.find((elem: any) => elem.name === name);
    } catch (error) {
         console.error(`Failed to find Part Studio by name "${name}": ${error}`);
         return undefined;
    }
}

// Helper to find an Assembly element by name (simplified)
export async function findAssemblyByName(documentId: string, workspaceId: string, name: string): Promise<any | undefined> {
    try {
        const queryParams = new URLSearchParams({
            elementType: 'ASSEMBLY'
        });
        const elements = await onshapeApiRequest(
            'GET',
            `/documents/d/${documentId}/w/${workspaceId}/elements`,
             undefined,
             queryParams
        );
        return elements.find((elem: any) => elem.name === name);
    } catch (error) {
         console.error(`Failed to find Assembly by name "${name}": ${error}`);
         return undefined;
    }
}