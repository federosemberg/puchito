require('dotenv').config();
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai');
const app = express();
const cors = require('cors');

app.use(cors({
    origin: 'http://localhost:8080', // Reemplaza con la URL de tu frontend
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const ASSISTANT_ID = process.env.ASSISTANT_ID;
let doc;

// Initialize Google Sheets
async function initializeSheets() {
    const auth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();
    return doc;
}

function rowToJson(row) {
    const headers = row._worksheet._headerValues;
    const values = row._rawData;
    const rowData = {};
    headers.forEach((header, index) => {
        rowData[header] = values[index] || null;
    });

    return rowData;
}

// Sheet operations
async function checkUserExists(phone) {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Clientes'];
    const rows = await sheet.getRows();

    const phoneColumn = sheet.headerValues.find(header => header.toLowerCase() === 'celular');

    if (!phoneColumn) {
        console.error("La columna 'Celular' no fue encontrada.");
        return null;
    }

    const user = rows.find(row => {
        const cellValue = row.get(phoneColumn) || '';
        const regex = new RegExp(phone, 'i');
        return regex.test(cellValue);
    });

    const userJson = user ? rowToJson(user) : '';
    console.log('Usuario encontrado:', userJson.Apodo, userJson['Tipo Cliente']); // Debug
    return userJson;
}

async function checkStock(searchTerm) {
    console.log('Verificando stock para:', searchTerm);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Inventario'];
    const rows = await sheet.getRows();

    // Columnas en las que buscaremos
    const searchableColumns = ['Nombre', 'Código', 'Proveedor', 'Tipo de Producto'];
    const searchQuery = searchTerm.toLowerCase();

    const products = rows
        .filter(row => {
            // Solo incluir productos activos y que se muestran en ventas
            const isActive = row.get('Activo')?.toLowerCase() === 'si';
            const showInSales = row.get('Mostrar en Ventas')?.toLowerCase() === 'si';

            if (!isActive || !showInSales) return false;

            // Buscar en todas las columnas especificadas
            return searchableColumns.some(column => {
                const cellValue = row.get(column)?.toLowerCase() || '';
                return cellValue.includes(searchQuery);
            });
        })
        .map(row => ({
            product: row.get('Nombre'),
            brand: row.get('Proveedor'),
            size: row.get('Código'),
            stock: {
                total: parseInt(row.get('Stock Total')) || 0,
                warehouse: row.get('Galpon') || 'No especificado',
                store: row.get('Negocio') || 'No especificado'
            }
        }));

    return products.length > 0 ? products : null;
}

async function checkPrice(searchTerm, threadInfo) {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Inventario'];
    const rows = await sheet.getRows();
    const searchQuery = searchTerm.toLowerCase();
    const clientType = threadInfo?.userData?.['Tipo Cliente'];
    
    console.log('Búsqueda:', searchQuery);
    console.log('Filas totales:', rows.length);

    const filteredRows = rows.filter(row => {
        const isActive = row.get('Activo')?.toLowerCase() === 'si';
        const showInSales = row.get('Mostrar en Ventas')?.toLowerCase() === 'si';
        const matchesSearch = ['Nombre', 'Código', 'Proveedor', 'Tipo de Producto'].some(column => {
            const value = row.get(column)?.toLowerCase() || '';
            const matches = value.includes(searchQuery);
            if (matches) console.log(`Coincidencia encontrada en ${column}:`, value);
            return matches;
        });
        
        return isActive && showInSales && matchesSearch;
    });

    console.log('Filas filtradas:', filteredRows.length);

    if (filteredRows.length === 0) return null;

    return filteredRows.map(row => ({
        product: row.get('Nombre'),
        brand: row.get('Proveedor'),
        size: row.get('Código'),
        price: getPriceByType(row, clientType),
        clientType,
        stock: parseInt(row.get('Stock Total')) || 0
    })).filter(product => product.stock > 0);
}

function getPriceByType(row, clientType) {
    switch (clientType) {
        case 'Reventa A':
            return parseFloat(row.get('Reventa A')) || 0;
        case 'Reventa B':
            return parseFloat(row.get('Reventa B')) || 0;
        default:
            return parseFloat(row.get('Precio de Venta')) || 0;
    }
}

async function generateUniqueReference() {
    // Genera un código con formato: RES-YYYYMMDD-XXXX (ej: RES-20241203-A1B2)
    const date = new Date();
    const dateStr = date.getFullYear() +
        String(date.getMonth() + 1).padStart(2, '0') +
        String(date.getDate()).padStart(2, '0');

    const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `RES-${dateStr}-${randomPart}`;
}

async function makeReservation(phone, product, quantity, threadInfo) {
    try {
        await doc.loadInfo();
        const inventorySheet = doc.sheetsByTitle['Inventario'];
        const reservationsSheet = doc.sheetsByTitle['Reservas'];
        const userSheet = doc.sheetsByTitle['Clientes'];
        const clientType = threadInfo?.userData?.['Tipo Cliente'] || 'Precio de Venta';

        // Verificar stock
        const currentStock = await checkStock(product);
        if (!currentStock || currentStock[0].stock.total < quantity) {
            return {
                success: false,
                message: "No hay suficiente stock disponible"
            };
        }

        // Buscar información del usuario
        const rows = await userSheet.getRows();
        const user = rows.find(row => {
            const userPhone = row.get('Celular') || '';
            return userPhone.includes(phone);
        });

        if (!user) {
            return {
                success: false,
                message: "Usuario no encontrado"
            };
        }

        // Obtener precio del producto
        const productInfo = await checkPrice(product, threadInfo);
        if (!productInfo) {
            return {
                success: false,
                message: "No se pudo obtener el precio del producto"
            };
        }

        // Generar código de referencia único
        const reference = await generateUniqueReference();

        // Actualizar stock
        const inventoryRows = await inventorySheet.getRows();
        const item = inventoryRows.find(row => row.get('Nombre').toLowerCase() === product.toLowerCase());
        const newStock = parseInt(item.get('Stock Total')) - quantity;
        item.set('Stock Total', newStock);
        await item.save();
        console.log(productInfo[0]);

        // Crear reserva
        const reservationData = {
            'Fecha': new Date().toISOString(),
            'Cliente': user.get('Nombre') + ' ' + user.get('Apellido'),
            'Telefono': phone,
            'Email': user.get('Mail') || '',
            'CUIT': user.get('CUIT') || 'No especificado',
            'Precio': productInfo[0].price * quantity,
            'Reference': reference,
            'Producto': product,
            'Medidas': productInfo[0].size,
            'Cantidad': quantity,
            'Status': 'Pendiente'
        };

        await reservationsSheet.addRow(reservationData);

        return {
            success: true,
            reference: reference,
            reservationDetails: {
                ...reservationData,
                message: `Reserva creada exitosamente. Tu código de referencia es: ${reference}`
            }
        };

    } catch (error) {
        console.error('Error al crear la reserva:', error);
        return {
            success: false,
            message: "Error al procesar la reserva",
            error: error.message
        };
    }
}

async function searchProducts(query, threadInfo) {
    console.log('Buscando productos con query:', query);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Inventario'];
    const rows = await sheet.getRows();
    const clientType = threadInfo?.userData?.['Tipo Cliente'];

    // Convertir query a minúsculas para búsqueda insensible a mayúsculas
    const searchQuery = query.toLowerCase();

    // Columnas en las que buscaremos
    const searchableColumns = ['Nombre', 'Código', 'Proveedor', 'Tipo de Producto'];

    return rows
        .filter(row => {
            // Solo incluir productos activos y que se muestran en ventas
            const isActive = row.get('Activo')?.toLowerCase() === 'si';
            const showInSales = row.get('Mostrar en Ventas')?.toLowerCase() === 'si';

            if (!isActive || !showInSales) return false;

            // Buscar en todas las columnas especificadas
            return searchableColumns.some(column => {
                const cellValue = row.get(column)?.toLowerCase() || '';
                return cellValue.includes(searchQuery);
            });
        })
        .map(row => ({
            id: row.get('Id'),
            product: row.get('Nombre'),
            brand: row.get('Proveedor'),
            type: row.get('Tipo de Producto'),
            size: row.get('Código'),
            stock: parseInt(row.get('Stock Total')) || 0,
            price: getPriceByType(row, clientType), //parseFloat(row.get('Precio de Venta')) || 0,
            description: row.get('Descripción'),
            image: row.get('Imagen'),
            warehouse: row.get('Galpon'),
            store: row.get('Negocio')
        }))
        .filter(product => product.stock > 0); // Solo mostrar productos con stock
}

// Thread management
const userThreads = new Map();

async function getOrCreateThread(from, userData = null) {
    if (!userThreads.has(from)) {
        const thread = await openai.beta.threads.create();
        userThreads.set(from, { threadId: thread.id, userData });
    }
    return userThreads.get(from);
}

// Assistant tools
const tools = [
    {
        type: "function",
        function: {
            name: "check_stock",
            description: "Consulta el stock disponible de un producto",
            parameters: {
                type: "object",
                properties: {
                    product: {
                        type: "string",
                        description: "Nombre del producto"
                    }
                },
                required: ["product"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "check_price",
            description: "Consulta el precio de un producto",
            parameters: {
                type: "object",
                properties: {
                    product: {
                        type: "string",
                        description: "Nombre del producto"
                    }
                },
                required: ["product"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "make_reservation",
            description: "Realiza una reserva de producto",
            parameters: {
                type: "object",
                properties: {
                    product: {
                        type: "string",
                        description: "Nombre del producto"
                    },
                    quantity: {
                        type: "number",
                        description: "Cantidad a reservar"
                    }
                },
                required: ["product", "quantity"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "msearch",
            description: "Busca productos por nombre",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Término de búsqueda"
                    }
                },
                required: ["query"]
            }
        }
    }
];

async function handleFunctionCall(toolCall, from) {
    const functionName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);
    const threadInfo = userThreads.get(from);

    switch (functionName) {
        case "check_stock":
            return await checkStock(args.product);
        case "check_price":
            return await checkPrice(args.product, threadInfo);
        case "make_reservation":
            return await makeReservation(from, args.product, args.quantity, threadInfo);
        case "msearch":
            return await searchProducts(args.query, threadInfo);
        default:
            throw new Error(`Unknown function: ${functionName}`);
    }
}

app.use(express.json());

app.get('/chat', async (req, res) => {
    try {
        const { from, message } = req.query;
        let threadInfo = userThreads.get(from);

        if (!threadInfo) {
            const userData = await checkUserExists(from);
            threadInfo = await getOrCreateThread(from, userData);

            if (userData) {
                const messageContent = `Nota inicial: Este usuario se llama ${userData.Nombre} ${userData.Apellido} y sus apodo es ${userData.Apodo} y es cliente tipo ${userData['Tipo Cliente']}. Siempre muestra los precios correspondientes a su tipo de cliente.`;

                if (messageContent) {
                    await openai.beta.threads.messages.create(threadInfo.threadId, {
                        role: "user",
                        content: messageContent
                    });
                } else {
                }
            } else {
                console.warn("No se encontró información del usuario.");
            }
        }

        const { threadId, userData } = threadInfo;

        // Procesa el mensaje con OpenAI
        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: message
        });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID,
            tools
        });

        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);

        while (runStatus.status !== 'completed' && runStatus.status !== 'failed') {
            if (runStatus.status === 'requires_action') {
                const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
                const toolOutputs = await Promise.all(toolCalls.map(async (toolCall) => ({
                    tool_call_id: toolCall.id,
                    output: JSON.stringify(await handleFunctionCall(toolCall, from))
                })));

                runStatus = await openai.beta.threads.runs.submitToolOutputs(
                    threadId,
                    run.id,
                    { tool_outputs: toolOutputs }
                );
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        }

        const messages = await openai.beta.threads.messages.list(threadId);

        const lastMessage = messages.data[0];

        res.status(200).json({
            message: lastMessage.content[0].text.value,
            sessionId: threadInfo.threadId
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeSheets();
    console.log(`Server running on port ${PORT}`);
});