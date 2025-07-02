import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceContents } from "@modelcontextprotocol/sdk/types.js";
import { onshapeApiRequest, getDefaultWorkspace, findPartStudioByName, findAssemblyByName } from "./onshapeApi.js";
import 'dotenv/config' // Load environment variables from .env
import { z } from "zod";
// Define the URI schemes for Onshape resources
const ONSHAPE_SCHEME = "onshape";
const DOC_URI_TEMPLATE = `${ONSHAPE_SCHEME}://document/{documentId}`;
const WVM_URI_TEMPLATE = `${ONSHAPE_SCHEME}://document/{documentId}/{wvm}/{wvmid}`; // w/v/m for workspace, version, microversion
const ELEMENT_URI_TEMPLATE = `${ONSHAPE_SCHEME}://document/{documentId}/{wvm}/{wvmid}/element/{elementId}`;
const PART_URI_TEMPLATE = `${ONSHAPE_SCHEME}://document/{documentId}/{wvm}/{wvmid}/element/{elementId}/part/{partId}`;

// Schema definitions for tools
const addAssemblyInstanceSchema = {
    documentId: z.string().describe("The ID of the target document (where the Assembly resides)."),
    workspaceId: z.string().describe("The ID of the target workspace (where the Assembly resides)."), 
    assemblyElementId: z.string().describe("The ID of the Assembly element."),
    // Details about the element to instance
    sourceDocumentId: z.string().describe("The ID of the document containing the element to instance."),
    sourceElementId: z.string().describe("The ID of the element (Part Studio, Assembly, Part, etc.) to instance."),
    sourceVersionId: z.string().optional().describe("Optional: The ID of the version of the source document/element."),
    sourceMicroversionId: z.string().optional().describe("Optional: The ID of the microversion of the source document/element."),
    sourcePartId: z.string().optional().describe("Optional: The ID of a specific part within the source element to instance."),
    sourceConfiguration: z.string().optional().describe("Optional: The configuration string (URL-encoded) of the source element/part."),
    // Optional transform
    transform: z.array(z.number()).length(12).optional().describe("Optional: A 4x4 transformation matrix (12 numbers representing 3 rows, 4 columns) as a flat array for placing the instance. If omitted, it's placed at the origin.")
};

const transformAssemblyInstancesSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    workspaceId: z.string().describe("The ID of the workspace."), 
    assemblyElementId: z.string().describe("The ID of the Assembly element."),
    occurrences: z.array(z.object({}).passthrough()).describe("An array of occurrence paths to transform. Each path is an array of instance IDs from the root down (e.g., [\"instance1id\", \"instance2id\"]). The JSON object should match BTOccurrence-74 structure { path: string[] }."),
    transform: z.array(z.number()).length(12).describe("A 4x4 transformation matrix (12 numbers representing 3 rows, 4 columns) as a flat array."),
    isRelative: z.boolean().optional().describe("Optional: If true, the transform is applied relative to the current position. Defaults to false (absolute transform).")
};

const getPartBoundingBoxSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    wvm: z.enum(["w", "v", "m"]).describe("w=workspace, v=version, m=microversion"),
    wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
    elementId: z.string().describe("The ID of the element."),
    partId: z.string().describe("The ID of the part."),
    configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded) of the element/part."),
    linkDocumentId: z.string().optional().describe("Optional: The ID of the linked document.")
};

const getElementBoundingBoxSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    wvm: z.enum(["w", "v", "m"]).describe("w=workspace, v=version, m=microversion"),
    wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
    elementId: z.string().describe("The ID of the element."),
    configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded) of the element."),
    linkDocumentId: z.string().optional().describe("Optional: The ID of the linked document.")
};

const getElementConfigurationDefinitionSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    wvm: z.enum(["w", "v", "m"]).describe("w=workspace, v=version, m=microversion"),
    wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
    elementId: z.string().describe("The ID of the element."),
    linkDocumentId: z.string().optional().describe("Optional: The ID of the linked document.")
};

const listPartStudioSketchesSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    wvm: z.enum(["w", "v", "m"]).describe("w=workspace, v=version, m=microversion"),
    wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
    elementId: z.string().describe("The ID of the element."),
    configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded) of the element."),
    linkDocumentId: z.string().optional().describe("Optional: The ID of the linked document.")
};

const getSketchTessellationSchema = {
    documentId: z.string().describe("The ID of the Onshape document."),
    wvm: z.enum(["w", "v", "m"]).describe("w=workspace, v=version, m=microversion"),
    wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
    partStudioElementId: z.string().describe("The ID of the Part Studio element."),
    sketchFeatureId: z.string().describe("The ID of the sketch feature."),
    entityId: z.string().optional().describe("Optional: The ID of a specific sketch entity."),
    configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded) of the Part Studio."),
    linkDocumentId: z.string().optional().describe("Optional: The ID of the linked document."),
    angleTolerance: z.number().optional().describe("Optional: The angle tolerance value for tessellation."),
    chordTolerance: z.number().optional().describe("Optional: The chord tolerance value for tessellation.")
};

async function startServer() {
    const server = new McpServer({
        name: "Onshape API Wrapper",
        version: "1.0.0",
        description: "Exposes granular Onshape API calls as MCP tools and resources for modeling."
    });

    // --- Resources ---
    // Resources provide context/read access. Write/Modification is via Tools.

    // Document Resource
    server.resource(
        "document",
        DOC_URI_TEMPLATE,
        async (uri: URL, context: any) => {
            // console.log(`Reading document resource: ${uri.href}`);
            try {
                const documentId = context.params.documentId;
                const docInfo = await onshapeApiRequest('GET', `/documents/${documentId}`);

                let contentText = `Onshape Document: ${docInfo.name}\n`;
                contentText += `ID: ${docInfo.id}\n`;
                contentText += `Description: ${docInfo.description || 'N/A'}\n`;
                contentText += `Owner: ${docInfo.owner?.name || 'N/A'}\n`;
                contentText += `Modified At: ${docInfo.modifiedAt}\n`;
                contentText += `Created At: ${docInfo.createdAt}\n`;
                if (docInfo.defaultWorkspace?.id) {
                    const defaultWsUri = new URL(WVM_URI_TEMPLATE.replace("{documentId}", docInfo.id).replace("{wvm}", "w").replace("{wvmid}", docInfo.defaultWorkspace.id));
                     contentText += `Default Workspace: ${docInfo.defaultWorkspace.name} (ID: ${docInfo.defaultWorkspace.id}) - @wvm(${defaultWsUri.href})\n`;
                }


                return {
                    contents: [{
                        uri: uri.href,
                        text: contentText,
                        mimeType: "text/plain"
                    }]
                };

            } catch (error: any) {
                 console.error(`Failed to read document resource ${uri.href}: ${error.message}`);
                 return {
                    contents: [{
                        uri: uri.href,
                        text: `Error reading document: ${error.message}`,
                        mimeType: "text/plain"
                    }],
                    isError: true
                 };
            }
        }
    );

    // WVM Resource (Workspace, Version, Microversion)
     server.resource(
        "wvm",
        WVM_URI_TEMPLATE,
        async (uri: URL, context: any) => {
            // console.log(`Reading WVM resource: ${uri.href}`);
            try {
                const { documentId, wvm, wvmid } = context.params;

                let wvmInfo: any;
                let contentText = `Onshape Document ${documentId} - ${wvm.toUpperCase()}: ${wvmid}\n`;

                if (wvm === 'w') {
                    wvmInfo = await onshapeApiRequest('GET', `/documents/d/${documentId}/workspaces/${wvmid}`);
                    contentText += `Workspace: "${wvmInfo.name}" (ID: ${wvmInfo.id})\n`;
                    contentText += `Microversion: ${wvmInfo.microversion}\n`;
                    contentText += `Modified At: ${wvmInfo.modifiedAt}\n`;
                } else if (wvm === 'v') {
                     wvmInfo = await onshapeApiRequest('GET', `/documents/d/${documentId}/versions/${wvmid}`);
                     contentText += `Version: "${wvmInfo.name}" (ID: ${wvmInfo.id})\n`;
                     contentText += `Microversion: ${wvmInfo.microversion}\n`;
                     contentText += `Created At: ${wvmInfo.createdAt}\n`;
                } else if (wvm === 'm') {
                     wvmInfo = await onshapeApiRequest('GET', `/documents/d/${documentId}/${wvm}/${wvmid}/currentmicroversion`);
                     contentText += `Microversion ID: ${wvmInfo.microversion}\n`;
                     // Onshape API doesn't provide much more detail directly for a raw microversion path
                } else {
                     throw new Error(`Invalid WVM type: ${wvm}`);
                }


                // Hint to the AI that it can list elements using a tool
                contentText += `\nUse the 'list_elements' tool with these parameters to see its contents.`;

                return {
                    contents: [{
                        uri: uri.href,
                        text: contentText,
                        mimeType: "text/plain"
                    }]
                };

            } catch (error: any) {
                 console.error(`Failed to read WVM resource ${uri.href}: ${error.message}`);
                 return {
                    contents: [{
                        uri: uri.href,
                        text: `Error reading WVM: ${error.message}`,
                        mimeType: "text/plain"
                    }],
                    isError: true
                 };
            }
        }
    );


    // Element Resource (Part Studio, Assembly, etc.)
    server.resource(
        "element",
         // Use a pattern that covers workspaces, versions, and microversions
        ELEMENT_URI_TEMPLATE,
        async (uri: URL, context: any) => {
            // console.log(`Reading element resource: ${uri.href}`);
            try {
                const { documentId, wvm, wvmid, elementId } = context.params;

                const elementInfo = await onshapeApiRequest(
                    'GET',
                    `/documents/d/${documentId}/${wvm}/${wvmid}/elements/${elementId}`
                );

                let contentText = `Onshape Element: "${elementInfo.name}"\n`;
                contentText += `Type: ${elementInfo.prettyType}\n`;
                contentText += `ID: ${elementId}\n`;
                contentText += `Document ID: ${documentId}\n`;
                contentText += `${wvm.toUpperCase()} ID: ${wvmid}\n`;
                if (elementInfo.microversionId) {
                     contentText += `Microversion ID: ${elementInfo.microversionId}\n`;
                }
                if (elementInfo.configuration) {
                     contentText += `Configuration: ${elementInfo.configuration}\n`;
                }

                // Hint at related tools based on element type
                if (elementInfo.elementType === 'PARTSTUDIO') {
                     contentText += `\nAvailable Tools for Part Studio:\n`;
                     contentText += `- get_part_studio_features\n`;
                     contentText += `- list_part_studio_feature_specs\n`;
                     contentText += `- add_part_studio_feature (Workspace only)\n`;
                     contentText += `- update_part_studio_feature (Workspace only)\n`;
                     contentText += `- delete_part_studio_feature (Workspace only)\n`;
                     contentText += `- get_part_bounding_box (requires partId)\n`;
                     contentText += `- get_part_studio_bounding_box\n`;
                     contentText += `- list_part_studio_sketches\n`;
                } else if (elementInfo.elementType === 'ASSEMBLY') {
                    contentText += `\nAvailable Tools for Assembly:\n`;
                     contentText += `- get_assembly_definition\n`;
                     contentText += `- add_assembly_instance (Workspace only)\n`;
                     contentText += `- transform_assembly_instance (Workspace only)\n`;
                     contentText += `- get_part_bounding_box (requires partId)\n`;
                     contentText += `- get_assembly_bounding_boxes\n`;
                }


                return {
                    contents: [{
                        uri: uri.href,
                        text: contentText,
                        mimeType: "text/plain"
                    }]
                };

            } catch (error: any) {
                 console.error(`Failed to read element resource ${uri.href}: ${error.message}`);
                 return {
                    contents: [{
                        uri: uri.href,
                        text: `Error reading element: ${error.message}`,
                        mimeType: "text/plain"
                    }],
                    isError: true
                 };
            }
        }
    );

    // Part Resource
     server.resource(
        "part",
        PART_URI_TEMPLATE,
        async (uri: URL, context: any) => {
            // console.log(`Reading part resource: ${uri.href}`);
            try {
                const { documentId, wvm, wvmid, elementId, partId } = context.params;

                 // Onshape API doesn't have a dedicated /part/{partId} endpoint
                 // We need to get the metadata via /metadata and filter for the specific part identity
                 // The partId in the URI is often the "part identity" used in metadata and BOMs.
                 // Let's use the metadata endpoint with the part identity (pi)
                const partMetadata = await onshapeApiRequest(
                    'GET',
                    `/metadata/d/${documentId}/${wvm}/${wvmid}/e/${elementId}/pi/${partId}`
                    // Add configuration if needed via query param
                );

                let contentText = `Onshape Part (Identity: ${partId})\n`;
                 contentText += `From Element ID: ${elementId}\n`;
                 contentText += `From Document ID: ${documentId}\n`;
                 contentText += `From ${wvm.toUpperCase()} ID: ${wvmid}\n`;

                // Include some key properties from the metadata
                const propertiesToList = ['Name', 'Part Number', 'Revision', 'Material', 'State']; // Add or remove as needed
                 if (partMetadata.properties && Array.isArray(partMetadata.properties)) {
                     propertiesToList.forEach(propName => {
                          const prop = partMetadata.properties.find((p: any) => p.name === propName);
                          if (prop) {
                              // Handle different value types, e.g., objects for Material
                              const value = typeof prop.value === 'object' ? JSON.stringify(prop.value) : prop.value;
                               contentText += `${propName}: ${value}\n`;
                          }
                     });
                 } else {
                      contentText += "Could not retrieve detailed properties.\n";
                 }


                return {
                    contents: [{
                        uri: uri.href,
                        text: contentText,
                        mimeType: "text/plain"
                    }]
                };

            } catch (error: any) {
                 console.error(`Failed to read part resource ${uri.href}: ${error.message}`);
                 return {
                    contents: [{
                        uri: uri.href,
                        text: `Error reading part: ${error.message}`,
                        mimeType: "text/plain"
                    }],
                    isError: true
                 };
            }
        }
    );


    // --- Tools ---

    // Tool: list_documents (Already implemented)
    server.tool(
        "list_documents",
        "Lists recent Onshape documents you own, providing their IDs and MCP resource URIs.",
        async (extra: any) => {
            // console.log("Tool call: list_documents");
            try {
                const documents = await onshapeApiRequest('GET', '/documents?filter=0&limit=20');
                let outputText = "Recent Documents (owned by you):\n";
                if (documents.items && documents.items.length > 0) {
                    documents.items.forEach((doc: any) => {
                         const resourceUri = new URL(DOC_URI_TEMPLATE.replace("{documentId}", doc.id));
                        outputText += `- "${doc.name}" (ID: ${doc.id}) - @document(${resourceUri.href})\n`;
                    });
                } else {
                    outputText += "No documents found.\n";
                }
                return { content: [{ type: "text", text: outputText }] };
            } catch (error: any) {
                console.error(`Error listing documents: ${error.message}`);
                return { content: [{ type: "text", text: `Error listing documents: ${error.message}` }], isError: true };
            }
        }
    );

    // Tool: list_elements
     const listElementsSchema = {
         documentId: z.string().describe("The ID of the Onshape document."),
         wvm: z.enum(["w", "v", "m"]).describe("Whether the ID refers to a workspace (w), version (v), or microversion (m)."),
         wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
         elementType: z.enum(["PARTSTUDIO", "ASSEMBLY", "DRAWING", "FEATURESTUDIO", "BLOB", "APPLICATION", "TABLE", "BILLOFMATERIALS", "VARIABLESTUDIO", "PUBLICATIONITEM"]).optional().describe("Optional: Filter by element type. Defaults to PARTSTUDIO and ASSEMBLY.")
     };

     server.tool(
         "list_elements",
         listElementsSchema,
         async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementType?: string }, extra: any) => {
             // console.log(`Tool call: list_elements for document ${params.documentId}/${params.wvm}/${params.wvmid}`);
             try {
                 const queryParams = new URLSearchParams();
                 // Default to Part Studio and Assembly if no type is specified
                 queryParams.append('elementType', params.elementType || 'PARTSTUDIO,ASSEMBLY');


                 const elements = await onshapeApiRequest(
                     'GET',
                     `/documents/d/${params.documentId}/${params.wvm}/${params.wvmid}/elements`,
                      undefined,
                      queryParams
                 );

                 let outputText = `Elements in document "${params.documentId}" (${params.wvm.toUpperCase()}: ${params.wvmid})${params.elementType ? ` (Type: ${params.elementType})` : ''}:\n`;
                 if (elements && elements.length > 0) {
                     elements.forEach((elem: any) => {
                          const resourceUri = new URL(ELEMENT_URI_TEMPLATE
                              .replace("{documentId}", params.documentId)
                              .replace("{wvm}", params.wvm)
                              .replace("{wvmid}", params.wvmid)
                              .replace("{elementId}", elem.id)
                          );
                         outputText += `- "${elem.name}" (ID: ${elem.id}, Type: ${elem.prettyType}) - @element(${resourceUri.href})\n`;
                     });
                 } else {
                     outputText += `No elements found matching the criteria in this state.\n`;
                 }

                 return { content: [{ type: "text", text: outputText }] };

             } catch (error: any) {
                 console.error(`Error listing elements: ${error.message}`);
                 return { content: [{ type: "text", text: `Error listing elements: ${error.message}` }], isError: true };
             }
         }
     );

    // Tool: create_document
    const createDocumentSchema = {
        name: z.string().describe("The name for the new Onshape document.")
    };

    server.tool(
        "create_document",
        createDocumentSchema,
        async (params: { name: string }, extra: any) => {
            // console.log(`Tool call: create_document named "${params.name}"`);
            try {
                const newDoc = await onshapeApiRequest('POST', '/documents', {
                    name: params.name
                });

                const resourceUri = new URL(DOC_URI_TEMPLATE.replace("{documentId}", newDoc.id));
                const outputText = `Created document "${newDoc.name}" (ID: ${newDoc.id}) - @document(${resourceUri.href})`;

                return { content: [{ type: "text", text: JSON.stringify(newDoc, null, 2) }] };

            } catch (error: any) {
                console.error(`Error creating document: ${error.message}`);
                return { content: [{ type: "text", text: `Error creating document: ${error.message}` }], isError: true };
            }
        }
    );

    // Tool: create_part_studio
    const createPartStudioSchema = {
        documentId: z.string().describe("The ID of the target document."),
        workspaceId: z.string().describe("The ID of the target workspace."),
        name: z.string().describe("The name for the new Part Studio.")
    };

    server.tool(
        "create_part_studio",
        createPartStudioSchema,
        async (params: { documentId: string, workspaceId: string, name: string }, extra: any) => {
            // console.log(`Tool call: create_part_studio named "${params.name}" in doc ${params.documentId}/${params.workspaceId}`);
            try {
                const newElement = await onshapeApiRequest('POST', `/partstudios/d/${params.documentId}/w/${params.workspaceId}`, {
                    name: params.name
                });

                const resourceUri = new URL(ELEMENT_URI_TEMPLATE
                    .replace("{documentId}", params.documentId)
                    .replace("{wvm}", "w")
                    .replace("{wvmid}", params.workspaceId)
                    .replace("{elementId}", newElement.id)
                );

                const outputText = `Created Part Studio "${newElement.name}" (ID: ${newElement.id}) in document ${params.documentId}/${params.workspaceId} - @element(${resourceUri.href})`;

                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error creating Part Studio: ${error.message}`);
                return { content: [{ type: "text", text: `Error creating Part Studio: ${error.message}` }], isError: true };
            }
        }
    );

    // Tool: create_assembly
    const createAssemblySchema = {
        documentId: z.string().describe("The ID of the target document."),
        workspaceId: z.string().describe("The ID of the target workspace."),
        name: z.string().describe("The name for the new Assembly.")
    };

    server.tool(
        "create_assembly",
        createAssemblySchema,
        async (params: { documentId: string, workspaceId: string, name: string }, extra: any) => {
            // console.log(`Tool call: create_assembly named "${params.name}" in doc ${params.documentId}/${params.workspaceId}`);
            try {
                const newElement = await onshapeApiRequest('POST', `/assemblies/d/${params.documentId}/w/${params.workspaceId}`, {
                    name: params.name
                });

                const resourceUri = new URL(ELEMENT_URI_TEMPLATE
                    .replace("{documentId}", params.documentId)
                    .replace("{wvm}", "w")
                    .replace("{wvmid}", params.workspaceId)
                    .replace("{elementId}", newElement.id)
                );

                const outputText = `Created Assembly "${newElement.name}" (ID: ${newElement.id}) in document ${params.documentId}/${params.workspaceId} - @element(${resourceUri.href})`;

                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error creating Assembly: ${error.message}`);
                return { content: [{ type: "text", text: `Error creating Assembly: ${error.message}` }], isError: true };
            }
        }
    );


    // Tool to get available feature specs for a Part Studio
    const listPartStudioFeatureSpecsSchema = {
        documentId: z.string().describe("The ID of the Onshape document."),
        wvm: z.enum(["w", "v", "m"]).describe("Whether the ID refers to a workspace (w), version (v), or microversion (m)."),
        wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
        elementId: z.string().describe("The ID of the Part Studio element.")
    };

    server.tool(
        "list_part_studio_feature_specs",
        listPartStudioFeatureSpecsSchema,
        async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string }, extra: any) => {
            // console.log(`Tool call: list_part_studio_feature_specs for element ${params.elementId} in doc ${params.documentId}/${params.wvm}/${params.wvmid}`);
            try {
                const featureSpecs = await onshapeApiRequest(
                    'GET',
                    `/partstudios/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/featurespecs`
                );

                let outputText = `Available Feature Specs for Part Studio "${params.elementId}":\n`;
                if (featureSpecs.featureSpecs && featureSpecs.featureSpecs.length > 0) {
                    featureSpecs.featureSpecs.forEach((spec: any) => {
                         // Provide basic info and hint that more details are in the API docs
                         outputText += `- "${spec.featureTypeName}" (Type: ${spec.featureType}, Namespace: ${spec.namespace})\n`;
                    });
                    outputText += "\nTo use a feature, call 'add_part_studio_feature' or 'update_part_studio_feature' with the correct JSON payload. Refer to Onshape's FeatureScript and REST API documentation for required parameters.";
                } else {
                    outputText += "No feature specs found for this Part Studio.\n";
                }

                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error listing feature specs: ${error.message}`);
                return { content: [{ type: "text", text: `Error listing feature specs: ${error.message}` }], isError: true };
            }
        }
    );


    // Tool to get the list of features currently in a Part Studio
    const getPartStudioFeaturesSchema = {
        documentId: z.string().describe("The ID of the Onshape document."),
        wvm: z.enum(["w", "v", "m"]).describe("Whether the ID refers to a workspace (w), version (v), or microversion (m)."),
        wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
        elementId: z.string().describe("The ID of the Part Studio element."),
        configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded) for configurable Part Studios."),
         linkDocumentId: z.string().optional().describe("Optional: The ID of the document through which the document is accessed, for linked documents.")
    };

    server.tool(
        "get_part_studio_features",
        getPartStudioFeaturesSchema,
        async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string, configuration?: string, linkDocumentId?: string }, extra: any) => {
            // console.log(`Tool call: get_part_studio_features for element ${params.elementId} in doc ${params.documentId}/${params.wvm}/${params.wvmid}`);
            try {
                 const queryParams = new URLSearchParams();
                 if (params.configuration) queryParams.append('configuration', params.configuration);
                 if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);

                const features = await onshapeApiRequest(
                    'GET',
                    `/partstudios/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/features`,
                     undefined,
                     queryParams
                );

                let outputText = `Features in Part Studio "${params.elementId}" (${params.wvm.toUpperCase()}: ${params.wvmid}):\n`;
                if (features.features && features.features.length > 0) {
                    features.features.forEach((feature: any) => {
                         outputText += `- "${feature.name}" (ID: ${feature.featureId}, Type: ${feature.featureType || feature.btType}) - ${feature.suppressed ? 'Suppressed' : 'Active'}\n`;
                    });
                     outputText += `\nSource Microversion for edits: ${features.sourceMicroversion}\n`; // Important context for add/update
                } else {
                    outputText += "No features found in this Part Studio.\n";
                }

                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error getting Part Studio features: ${error.message}`);
                return { content: [{ type: "text", text: `Error getting Part Studio features: ${error.message}` }], isError: true };
            }
        }
    );


    // Tool to add a feature to a Part Studio (Requires complex JSON payload)
    const addPartStudioFeatureSchema = {
        documentId: z.string().describe("The ID of the Onshape document."),
        workspaceId: z.string().describe("The ID of the target workspace."), // Add feature requires workspace
        elementId: z.string().describe("The ID of the Part Studio element."),
         // The FeatureScript feature definition as a JSON object.
         // This is the tricky part for the AI. It needs to understand the structure.
         // We use passthrough as Zod can't validate the arbitrary FS feature JSON.
        feature: z.object({}).passthrough().describe("The JSON object representing the FeatureScript feature definition (e.g., Sketch, Extrude, Pattern). Refer to Onshape's FeatureScript and API documentation for the required structure (BTFeatureDefinitionCall-1406 -> feature field).")
    };

    server.tool(
        "add_part_studio_feature",
        addPartStudioFeatureSchema,
        async (params: { documentId: string, workspaceId: string, elementId: string, feature: any }, extra: any) => {
            // console.log(`Tool call: add_part_studio_feature to element ${params.elementId} in doc ${params.documentId}/${params.workspaceId}`);

            let featureDefinitionCall;

            try {
                // The API requires the FeatureDefinitionCall object, not just the inner feature
                // We need to fetch the current state to get correct serialization/library versions
                const currentFeatures = await onshapeApiRequest(
                     'GET',
                     `/partstudios/d/${params.documentId}/w/${params.workspaceId}/e/${params.elementId}/features`
                );

                if (!currentFeatures || !currentFeatures.serializationVersion || !currentFeatures.libraryVersion || !currentFeatures.sourceMicroversion) {
                     throw new Error("Failed to fetch necessary Part Studio metadata for adding feature.");
                }


                featureDefinitionCall = {
                    feature: params.feature,
                    serializationVersion: currentFeatures.serializationVersion,
                    sourceMicroversion: currentFeatures.sourceMicroversion,
                    libraryVersion: currentFeatures.libraryVersion
                };

                // console.log("Attempting to add feature with payload:", JSON.stringify(featureDefinitionCall, null, 2));

                const response = await onshapeApiRequest(
                    'POST',
                    `/partstudios/d/${params.documentId}/w/${params.workspaceId}/e/${params.elementId}/features`,
                    featureDefinitionCall
                );

                let outputText = `Feature added successfully.\n Input: \n` + JSON.stringify(featureDefinitionCall) + `\n Output: \n` + JSON.stringify(response);
                if (response.feature && response.feature.name) {
                     outputText += ` Name: "${response.feature.name}"`;
                }
                 if (response.feature && response.feature.featureId) {
                      outputText += ` (ID: ${response.feature.featureId})\n`;
                 } else {
                      outputText += "\n"
                 }

                outputText += `New Microversion: ${response.sourceMicroversion}\n`;
                if (response.featureState && response.featureState.featureStatus === 'ERROR') {
                     outputText += `Warning: The added feature resulted in an error state.\n`;
                     // Add more details from featureState if available and helpful
                     if (response.featureState.errorMessage) {
                          outputText += `Error Message: ${response.featureState.errorMessage}\n`;
                     }
                } else if (response.notices && response.notices.length > 0) {
                    // Sometimes warnings or info are in 'notices' array
                    outputText += "FeatureScript Notices:\n";
                    response.notices.forEach((notice: any) => {
                        outputText += `- [${notice.level}] ${notice.message}\n`;
                    });
                }


                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error adding feature: ${error.message}`);
                 return { content: [{ type: "text", text: `Error adding feature: ${error.message}  + ${JSON.stringify(featureDefinitionCall, null, 2)}` }], isError: true };
            }
        }
    );

    // Tool to update an existing feature in a Part Studio (Requires complex JSON payload)
    const updatePartStudioFeatureSchema = {
        documentId: z.string().describe("The ID of the Onshape document."),
        workspaceId: z.string().describe("The ID of the target workspace."), // Update requires workspace
        elementId: z.string().describe("The ID of the Part Studio element."),
        featureId: z.string().describe("The ID of the feature to update. Obtain this from get_part_studio_features."),
         feature: z.object({}).passthrough().describe("The JSON object representing the updated FeatureScript feature definition. Must include the matching featureId. Refer to Onshape's FeatureScript and API documentation for the required structure.")
    };

    server.tool(
        "update_part_studio_feature",
        updatePartStudioFeatureSchema,
        async (params: { documentId: string, workspaceId: string, elementId: string, featureId: string, feature: any }, extra: any) => {
            // console.log(`Tool call: update_part_studio_feature ${params.featureId} in element ${params.elementId} in doc ${params.documentId}/${params.workspaceId}`);

            try {
                // Fetch current state for versioning info
                 const currentFeatures = await onshapeApiRequest(
                      'GET',
                      `/partstudios/d/${params.documentId}/w/${params.workspaceId}/e/${params.elementId}/features`
                 );

                 if (!currentFeatures || !currentFeatures.serializationVersion || !currentFeatures.libraryVersion || !currentFeatures.sourceMicroversion) {
                      throw new Error("Failed to fetch necessary Part Studio metadata for updating feature.");
                 }

                // The API requires the FeatureDefinitionCall object
                const featureDefinitionCall = {
                    feature: params.feature,
                    serializationVersion: currentFeatures.serializationVersion,
                    sourceMicroversion: currentFeatures.sourceMicroversion,
                    libraryVersion: currentFeatures.libraryVersion
                };

                // console.log("Attempting to update feature with payload:", JSON.stringify(featureDefinitionCall, null, 2));


                const response = await onshapeApiRequest(
                    'POST',
                    `/partstudios/d/${params.documentId}/w/${params.workspaceId}/e/${params.elementId}/features/featureid/${encodeURIComponent(params.featureId)}`,
                    featureDefinitionCall
                );

                let outputText = `Feature "${params.featureId}" updated successfully.\n`;
                outputText += `New Microversion: ${response.sourceMicroversion}\n`;
                if (response.featureState && response.featureState.featureStatus === 'ERROR') {
                     outputText += `Warning: The updated feature resulted in an error state.\n`;
                      if (response.featureState.errorMessage) {
                          outputText += `Error Message: ${response.featureState.errorMessage}\n`;
                      }
                } else if (response.notices && response.notices.length > 0) {
                    outputText += "FeatureScript Notices:\n";
                    response.notices.forEach((notice: any) => {
                        outputText += `- [${notice.level}] ${notice.message}\n`;
                    });
                }


                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error updating feature ${params.featureId}: ${error.message}`);
                 return { content: [{ type: "text", text: `Error updating feature ${params.featureId}: ${error.message}` }], isError: true };
            }
        }
    );

    // Tool to delete a feature from a Part Studio
    const deletePartStudioFeatureSchema = {
        documentId: z.string().describe("The ID of the Onshape document."),
        workspaceId: z.string().describe("The ID of the workspace."), // Delete requires workspace
        elementId: z.string().describe("The ID of the Part Studio element."),
        featureId: z.string().describe("The ID of the feature to delete. Obtain this from get_part_studio_features.")
    };

    server.tool(
        "delete_part_studio_feature",
        deletePartStudioFeatureSchema,
        async (params: { documentId: string, workspaceId: string, elementId: string, featureId: string }, extra: any) => {
            // console.log(`Tool call: delete_part_studio_feature ${params.featureId} in element ${params.elementId} in doc ${params.documentId}/${params.workspaceId}`);

            try {
                // Note: Onshape API DELETE feature endpoint might return the modified feature list response
                const response = await onshapeApiRequest(
                    'DELETE',
                    `/partstudios/d/${params.documentId}/w/${params.workspaceId}/e/${params.elementId}/features/featureid/${encodeURIComponent(params.featureId)}`
                );

                 let outputText = `Feature "${params.featureId}" deleted successfully.\n`;
                 // The response structure for DELETE can vary. Check response structure for errors if needed.
                 // The API doc suggests it returns BTFeatureApiBase-1430, which has notices and microversion info.
                 if (response.microversionSkew) {
                      outputText += "Warning: Microversion skew detected during deletion.\n";
                 }
                 if (response.notices && response.notices.length > 0) {
                    outputText += "Notices during deletion:\n";
                    response.notices.forEach((notice: any) => {
                        outputText += `- [${notice.level}] ${notice.message}\n`;
                    });
                 }


                return { content: [{ type: "text", text: outputText }] };

            } catch (error: any) {
                console.error(`Error deleting feature ${params.featureId}: ${error.message}`);
                 return { content: [{ type: "text", text: `Error deleting feature ${params.featureId}: ${error.message}` }], isError: true };
            }
        }
    );


    // Tool to get the definition of an Assembly
     const getAssemblyDefinitionSchema = {
          documentId: z.string().describe("The ID of the Onshape document."),
          wvm: z.enum(["w", "v", "m"]).describe("Whether the ID refers to a workspace (w), version (v), or microversion (m)."),
          wvmid: z.string().describe("The ID of the workspace, version, or microversion."),
          elementId: z.string().describe("The ID of the Assembly element."),
          configuration: z.string().optional().describe("Optional: The configuration string (URL-encoded)."),
          explodedViewId: z.string().optional().describe("Optional: The ID of the exploded view."),
          includeMateFeatures: z.boolean().optional().describe("Optional: Include mate features. Defaults to false."),
          includeNonSolids: z.boolean().optional().describe("Optional: Include non-solid geometry. Defaults to false."),
          includeMateConnectors: z.boolean().optional().describe("Optional: Include mate connectors. Defaults to false."),
          excludeSuppressed: z.boolean().optional().describe("Optional: Exclude suppressed instances/features. Defaults to false.")
      };

      server.tool(
           "get_assembly_definition",
           getAssemblyDefinitionSchema,
           async (params: {
                documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string,
                configuration?: string, explodedViewId?: string, includeMateFeatures?: boolean,
                includeNonSolids?: boolean, includeMateConnectors?: boolean, excludeSuppressed?: boolean
            }, extra: any): Promise<any> => {
               // console.log(`Tool call: get_assembly_definition for element ${params.elementId} in doc ${params.documentId}/${params.wvm}/${params.wvmid}`);
               try {
                    const queryParams = new URLSearchParams();
                    if (params.configuration) queryParams.append('configuration', params.configuration);
                    if (params.explodedViewId) queryParams.append('explodedViewId', params.explodedViewId);
                    if (params.includeMateFeatures !== undefined) queryParams.append('includeMateFeatures', params.includeMateFeatures.toString());
                    if (params.includeNonSolids !== undefined) queryParams.append('includeNonSolids', params.includeNonSolids.toString());
                    if (params.includeMateConnectors !== undefined) queryParams.append('includeMateConnectors', params.includeMateConnectors.toString());
                    if (params.excludeSuppressed !== undefined) queryParams.append('excludeSuppressed', params.excludeSuppressed.toString());

                   const assemblyDefinition = await onshapeApiRequest(
                       'GET',
                       `/assemblies/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}`,
                        undefined,
                        queryParams
                   );

                    // This response can be very large and nested. Summarize for the AI.
                   let outputText = `Assembly Definition for "${params.elementId}" (${params.wvm.toUpperCase()}: ${params.wvmid}):\n`;
                   if (assemblyDefinition.rootAssembly) {
                       outputText += `Root Assembly:\n`;
                       outputText += `  Instances: ${assemblyDefinition.rootAssembly.instances?.length || 0}\n`;
                       outputText += `  Features: ${assemblyDefinition.rootAssembly.features?.length || 0}\n`;
                       // List a few instances as examples
                        if (assemblyDefinition.rootAssembly.instances && assemblyDefinition.rootAssembly.instances.length > 0) {
                            outputText += `  Example Instances:\n`;
                            assemblyDefinition.rootAssembly.instances.slice(0, 5).forEach((inst: any) => {
                                outputText += `    - "${inst.name}" (ID: ${inst.id}, Type: ${inst.type}, Part ID: ${inst.partId || 'N/A'})\n`;
                            });
                            if (assemblyDefinition.rootAssembly.instances.length > 5) {
                                outputText += `    (...${assemblyDefinition.rootAssembly.instances.length - 5} more instances)\n`;
                            }
                        }
                   }
                    if (assemblyDefinition.subAssemblies && assemblyDefinition.subAssemblies.length > 0) {
                         outputText += `Sub-Assemblies: ${assemblyDefinition.subAssemblies.length}\n`;
                    }
                   if (assemblyDefinition.parts && assemblyDefinition.parts.length > 0) {
                        outputText += `Parts (Instances): ${assemblyDefinition.parts.length}\n`;
                         // List a few parts as examples
                        if (assemblyDefinition.parts.length > 0) {
                            outputText += `  Example Parts:\n`;
                            assemblyDefinition.parts.slice(0, 5).forEach((part: any) => {
                                outputText += `    - Type: ${part.bodyType}, Doc ID: ${part.documentId}, Elem ID: ${part.elementId}, Part ID: ${part.partId}\n`;
                            });
                             if (assemblyDefinition.parts.length > 5) {
                                 outputText += `    (...${assemblyDefinition.parts.length - 5} more parts)\n`;
                             }
                        }
                   }


                   return { content: [{ type: "text", text: outputText }] };

               } catch (error: any) {
                   console.error(`Error getting assembly definition: ${error.message}`);
                    return { content: [{ type: "text", text: `Error getting assembly definition: ${error.message}` }], isError: true };
               }
           }
      );


      // Tool to add an instance to an Assembly (Requires complex JSON payload)
       server.tool(
          "add_assembly_instance",
          addAssemblyInstanceSchema,
          async (params: {
              documentId: string, 
              workspaceId: string, 
              assemblyElementId: string,
              sourceDocumentId: string,
              sourceElementId: string,
              sourceVersionId?: string,
              sourceMicroversionId?: string,
              sourcePartId?: string,
              sourceConfiguration?: string,
              transform?: number[]
          }, extra: any) => {
              // console.log(`Tool call: add_assembly_instance in assembly ${params.assemblyElementId}`);
              try {
                  // Create a new instance of an element (Part Studio, part, or sub-assembly) in an assembly
                  let endpoint = `/assemblies/d/${params.documentId}/w/${params.workspaceId}/e/${params.assemblyElementId}/instances`;
                  
                  // Construct the request body
                  const requestBody: any = {
                      documentId: params.sourceDocumentId,
                      elementId: params.sourceElementId,
                  };

                  // Add optional parameters if provided
                  if (params.sourceVersionId) requestBody.versionId = params.sourceVersionId;
                  if (params.sourceMicroversionId) requestBody.microversionId = params.sourceMicroversionId;
                  if (params.sourcePartId) requestBody.partId = params.sourcePartId;
                  if (params.sourceConfiguration) requestBody.configuration = params.sourceConfiguration;
                  if (params.transform) requestBody.transform = params.transform;

                  const response = await onshapeApiRequest(
                      'POST',
                      endpoint,
                      requestBody
                  );
                  
                  let outputText = `Assembly instance added successfully.\n`;
                  if (response.name) {
                      outputText += `Instance name: "${response.name}"\n`;
                  }
                  if (response.id) {
                      outputText += `Instance ID: ${response.id}\n`;
                  }
                  
                  return { content: [{ type: "text", text: outputText }] };
              }
              catch (error: any) {
                  console.error(`Error adding assembly instance: ${error.message}`);
                  return { content: [{ type: "text", text: `Error adding assembly instance: ${error.message}` }], isError: true };
              }
          }
      );


      // Tool to transform existing Assembly instances (Requires complex JSON payload)
       server.tool(
          "transform_assembly_instances",
          transformAssemblyInstancesSchema,
          async (params: {
              documentId: string, 
              workspaceId: string, 
              assemblyElementId: string,
              occurrences: any[],
              transform: number[],
              isRelative?: boolean
          }, extra: any) => {
              // console.log(`Tool call: transform_assembly_instances in assembly ${params.assemblyElementId}`);
              try {
                  // Transform instances within an assembly
                  let endpoint = `/assemblies/d/${params.documentId}/w/${params.workspaceId}/e/${params.assemblyElementId}/transformoccurrences`;
                  
                  // Construct the request body
                  const requestBody: any = {
                      occurrences: params.occurrences,
                      transform: params.transform,
                  };

                  // Add isRelative if provided
                  if (params.isRelative !== undefined) requestBody.isRelative = params.isRelative;

                  const response = await onshapeApiRequest(
                      'POST',
                      endpoint,
                      requestBody
                  );
                  
                  let outputText = `Assembly instances transformed successfully.\n`;
                  
                  return { content: [{ type: "text", text: outputText }] };
              }
              catch (error: any) {
                  console.error(`Error transforming assembly instances: ${error.message}`);
                  return { content: [{ type: "text", text: `Error transforming assembly instances: ${error.message}` }], isError: true };
              }
          }
      );

      // Tool to get the bounding box for a specific part
       server.tool(
          "get_part_bounding_box",
          getPartBoundingBoxSchema,
          async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string, partId: string, configuration?: string, linkDocumentId?: string }, extra: any): Promise<any> => {
              // console.log(`Tool call: get_part_bounding_box for part ${params.partId} in element ${params.elementId}`);
              try {
                   const queryParams = new URLSearchParams();
                   if (params.configuration) queryParams.append('configuration', params.configuration);
                   if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);
                   // includeHidden defaults to false, which is usually desired

                  const bboxResponse = await onshapeApiRequest(
                      'GET',
                      `/parts/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/partid/${params.partId}/boundingboxes`,
                       undefined,
                       queryParams
                  );

                  let outputText = `Bounding Box for Part ${params.partId}:\n`;
                  if (bboxResponse && bboxResponse.lowX !== undefined) {
                       outputText += `  Low Corner: [${bboxResponse.lowX}, ${bboxResponse.lowY}, ${bboxResponse.lowZ}]\n`;
                       outputText += `  High Corner: [${bboxResponse.highX}, ${bboxResponse.highY}, ${bboxResponse.highZ}]\n`;
                       outputText += `(Coordinates in meters)`; // Onshape API returns in meters by default
                  } else {
                       outputText += "Could not retrieve bounding box.\n";
                  }

                  return { content: [{ type: "text", text: outputText }] };

              } catch (error: any) {
                  console.error(`Error getting part bounding box ${params.partId}: ${error.message}`);
                   return { content: [{ type: "text", text: `Error getting part bounding box ${params.partId}: ${error.message}` }], isError: true };
              }
          }
      );

      // Tool to get the bounding box for an entire Part Studio or Assembly
       server.tool(
          "get_element_bounding_box",
          getElementBoundingBoxSchema,
          async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string, configuration?: string, linkDocumentId?: string }, extra: any): Promise<any> => {
              // console.log(`Tool call: get_element_bounding_box for element ${params.elementId}`);
              try {
                  // Need to determine element type to call correct endpoint (PartStudio or Assembly)
                  const elementInfo = await onshapeApiRequest(
                      'GET',
                      `/documents/d/${params.documentId}/${params.wvm}/${params.wvmid}/elements/${params.elementId}`
                  );

                  let endpointPath: string;
                  if (elementInfo.elementType === 'PARTSTUDIO') {
                       endpointPath = `/partstudios/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/boundingboxes`;
                  } else if (elementInfo.elementType === 'ASSEMBLY') {
                       endpointPath = `/assemblies/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/boundingboxes`;
                  } else {
                       return {
                           content: [{ type: "text", text: `Error: Bounding box is only supported for Part Studio or Assembly elements (Type: ${elementInfo.prettyType}).` }],
                           isError: true
                       };
                  }

                   const queryParams = new URLSearchParams();
                   if (params.configuration) queryParams.append('configuration', params.configuration);
                   if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);
                   // includeHidden defaults to false, includeWireBodies defaults to true (for PS)

                  const bboxResponse = await onshapeApiRequest(
                      'GET',
                       endpointPath,
                       undefined,
                       queryParams
                  );

                  let outputText = `Bounding Box for Element "${elementInfo.name}" (ID: ${params.elementId}):\n`;
                  if (bboxResponse && bboxResponse.lowX !== undefined) {
                       outputText += `  Low Corner: [${bboxResponse.lowX}, ${bboxResponse.lowY}, ${bboxResponse.lowZ}]\n`;
                       outputText += `  High Corner: [${bboxResponse.highX}, ${bboxResponse.highY}, ${bboxResponse.highZ}]\n`;
                       outputText += `(Coordinates in meters)`; // Onshape API returns in meters by default
                  } else {
                       outputText += "Could not retrieve bounding box.\n";
                  }

                  return { content: [{ type: "text", text: outputText }] };

              } catch (error: any) {
                  console.error(`Error getting element bounding box ${params.elementId}: ${error.message}`);
                   return { content: [{ type: "text", text: `Error getting element bounding box ${params.elementId}: ${error.message}` }], isError: true };
              }
          }
      );

      // Tool to get the configuration definition for an element
       server.tool(
           "get_element_configuration_definition",
           getElementConfigurationDefinitionSchema,
           async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string, linkDocumentId?: string }, extra: any): Promise<any> => {
               // console.log(`Tool call: get_element_configuration_definition for element ${params.elementId}`);
               try {
                    const queryParams = new URLSearchParams();
                    if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);

                   const configDefinition = await onshapeApiRequest(
                       'GET',
                       `/elements/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/configuration`,
                        undefined,
                        queryParams
                   );

                   // Summarize the configuration parameters
                   let outputText = `Configuration Definition for Element "${params.elementId}":\n`;
                   if (configDefinition.configurationParameters && configDefinition.configurationParameters.length > 0) {
                       outputText += `Parameters:\n`;
                       configDefinition.configurationParameters.forEach((param: any) => {
                            outputText += `- "${param.parameterName}" (ID: ${param.parameterId}, Type: ${param.parameterType})\n`;
                            if (param.description) {
                                outputText += `  Description: ${param.description}\n`;
                            }
                            if (param.options && param.options.length > 0) {
                                outputText += `  Options: ${param.options.join(', ')}\n`;
                            }
                             // Add more details based on parameter type if helpful
                       });
                       outputText += `\nSource Microversion: ${configDefinition.sourceMicroversion}\n`; // Important context for update

                   } else {
                       outputText += "This element has no configuration parameters.\n";
                   }


                   return { content: [{ type: "text", text: outputText }] };

               } catch (error: any) {
                   console.error(`Error getting element configuration definition: ${error.message}`);
                    return { content: [{ type: "text", text: `Error getting element configuration definition: ${error.message}` }], isError: true };
               }
           }
       );


      // Tool to list sketches in a Part Studio
       server.tool(
           "list_part_studio_sketches",
           listPartStudioSketchesSchema,
           async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, elementId: string, configuration?: string, linkDocumentId?: string }, extra: any): Promise<any> => {
               // console.log(`Tool call: list_part_studio_sketches for element ${params.elementId}`);
               try {
                    const queryParams = new URLSearchParams();
                    if (params.configuration) queryParams.append('configuration', params.configuration);
                    if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);
                    // Default to include geometry (includeGeometry=true) and not output 3D (output3D=false)

                   const sketchInfo = await onshapeApiRequest(
                       'GET',
                       `/partstudios/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.elementId}/sketches`,
                        undefined,
                        queryParams
                   );

                    // The response structure is an object with feature IDs as keys, each containing sketch info
                    let outputText = `Sketches in Part Studio "${params.elementId}" (${params.wvm.toUpperCase()}: ${params.wvmid}):\n`;
                    const sketchFeatures = Object.entries(sketchInfo) // Assuming sketchInfo is the map { featureId: sketchData }
                        .map(([featureId, data]: [string, any]) => ({ featureId, ...data }))
                        .filter(s => s.entities && s.entities.length > 0); // Filter out empty sketches if needed


                   if (sketchFeatures.length > 0) {
                       sketchFeatures.forEach((sketch: any) => {
                            // Find the sketch feature name from the feature list (requires another call or caching)
                            // For simplicity here, just use the feature ID
                           outputText += `- Feature ID: ${sketch.featureId}, Entities: ${sketch.entities.length}\n`;
                            // Add more summary info if sketch object structure is better understood
                       });
                   } else {
                       outputText += "No sketches found in this Part Studio.\n";
                   }


                   return { content: [{ type: "text", text: outputText }] };

               } catch (error: any) {
                   console.error(`Error listing Part Studio sketches: ${error.message}`);
                    return { content: [{ type: "text", text: `Error listing Part Studio sketches: ${error.message}` }], isError: true };
               }
           }
       );

      // Tool to get the tessellation (geometric data) of a specific sketch entity
       server.tool(
           "get_sketch_tessellation",
           getSketchTessellationSchema,
           async (params: { documentId: string, wvm: "w" | "v" | "m", wvmid: string, partStudioElementId: string, sketchFeatureId: string, entityId?: string, configuration?: string, linkDocumentId?: string, angleTolerance?: number, chordTolerance?: number }, extra: any): Promise<any> => {
               // console.log(`Tool call: get_sketch_tessellation for sketch ${params.sketchFeatureId} in element ${params.partStudioElementId}`);
               try {
                    const queryParams = new URLSearchParams();
                    if (params.entityId) queryParams.append('entityId', params.entityId);
                    if (params.configuration) queryParams.append('configuration', params.configuration);
                    if (params.linkDocumentId) queryParams.append('linkDocumentId', params.linkDocumentId);
                    if (params.angleTolerance !== undefined) queryParams.append('angleTolerance', params.angleTolerance.toString());
                    if (params.chordTolerance !== undefined) queryParams.append('chordTolerance', params.chordTolerance.toString());

                   const tessellationData = await onshapeApiRequest(
                       'GET',
                       `/partstudios/d/${params.documentId}/${params.wvm}/${params.wvmid}/e/${params.partStudioElementId}/sketches/${params.sketchFeatureId}/tessellatedentities`,
                        undefined,
                        queryParams
                   );

                    // The response structure contains geometric data, which is hard to represent purely in text.
                    // Provide a summary and maybe the raw JSON (if the client can handle it).
                    let outputText = `Tessellation Data for Sketch ${params.sketchFeatureId}${params.entityId ? ` Entity ${params.entityId}` : ''}:\n`;
                    // How to summarize depends heavily on the structure of the tessellation data object
                    // The OpenAPI spec just says 'object'. You would need to inspect actual responses.
                    // Example summary (might need adjustment based on real response):
                    if (tessellationData && typeof tessellationData === 'object') {
                         const numEntities = Object.keys(tessellationData).length;
                         outputText += `  Contains data for ${numEntities} entities.\n`;
                          // Pick a sample entity to describe?
                          const firstEntityId = Object.keys(tessellationData)[0];
                          if (firstEntityId) {
                               const entityData = tessellationData[firstEntityId];
                               if (entityData && entityData.lines && Array.isArray(entityData.lines)) {
                                    outputText += `  Example Entity (${firstEntityId}): has ${entityData.lines.length} line segments.\n`;
                               } else if (entityData && entityData.points && Array.isArray(entityData.points)) {
                                    outputText += `  Example Entity (${firstEntityId}): has ${entityData.points.length / 2} points.\n`; // Assuming 2D points
                               } else {
                                    outputText += `  Example Entity (${firstEntityId}): structure unknown.\n`;
                               }
                          }

                        // Optionally include the raw JSON data if needed by the AI client
                        // outputText += `\nRaw Data:\n\`\`\`json\n${JSON.stringify(tessellationData, null, 2)}\n\`\`\``; // Be cautious with size
                    } else {
                        outputText += "Could not retrieve tessellation data.\n";
                    }


                    return { content: [{ type: "text", text: outputText }] };

               } catch (error: any) {
                   console.error(`Error getting sketch tessellation: ${error.message}`);
                    return { content: [{ type: "text", text: `Error getting sketch tessellation: ${error.message}` }], isError: true };
               }
           }
       );


    // Start receiving messages on stdin and sending messages on stdout
    const transport = new StdioServerTransport();
    // console.log("Onshape MCP Server (Generic API Wrapper) started (stdio). Waiting for client connection...");
    await server.connect(transport);
    // console.log("Client connected. Server is ready.");
}

startServer().catch(console.error);