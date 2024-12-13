require('dotenv').config();
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai');
const app = express();
const cors = require('cors');
const axios = require('axios');

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
            },
            imageUrl: getImageUrl(row.get('Imagen'))  // Usa la función auxiliar
        }));

    return products.length > 0 ? products : null;
}

async function checkPrice(searchTerm, threadInfo, size = null) {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Inventario'];
    const rows = await sheet.getRows();
    const searchQuery = searchTerm.toLowerCase();
    const clientType = threadInfo?.userData?.['Tipo Cliente'];

    const filteredRows = rows.filter(row => {
        const isActive = row.get('Activo')?.toLowerCase() === 'si';
        const showInSales = row.get('Mostrar en Ventas')?.toLowerCase() === 'si';

        // Verificar nombre del producto
        const nameMatch = row.get('Nombre')?.toLowerCase().includes(searchQuery);

        // Si se proporciona size, verificar también el código
        const sizeMatch = size ?
            row.get('Código')?.toLowerCase() === size.toLowerCase() :
            true;

        return isActive && showInSales && nameMatch && sizeMatch;
    });

    if (filteredRows.length === 0) return null;

    return filteredRows.map(row => ({
        product: row.get('Nombre'),
        brand: row.get('Proveedor'),
        size: row.get('Código'),
        price: getPriceByType(row, clientType),
        clientType,
        stock: parseInt(row.get('Stock Total')) || 0,
        imageUrl: getImageUrl(row.get('Imagen'))
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

        // Separar el producto y el tamaño si vienen juntos
        let productName = product;
        let size = null;

        if (product.includes(' ')) {
            // Asumimos que el último término es el tamaño
            const terms = product.split(' ');
            size = terms.pop();
            productName = terms.join(' ');
        }

        // Buscar productos con el nombre y tamaño específicos
        const matchingProducts = await checkPrice(productName, threadInfo, size);

        if (!matchingProducts || matchingProducts.length === 0) {
            return {
                success: false,
                message: "Producto no encontrado"
            };
        }

        if (matchingProducts.length > 1) {
            // Si hay múltiples productos, devolver la lista para que el assistant pueda pedir especificación
            return {
                success: false,
                message: "Múltiples productos encontrados",
                products: matchingProducts.map(p => ({
                    name: p.product,
                    size: p.size,
                    brand: p.brand,
                    stock: p.stock,
                    price: p.price
                })),
                requiresSpecification: true
            };
        }

        // Continuar con la reserva si solo hay un producto
        const productInfo = matchingProducts[0];

        // Verificar stock
        if (productInfo.stock < quantity) {
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

        // Generar código de referencia único
        const reference = await generateUniqueReference();

        // Actualizar stock
        const inventoryRows = await inventorySheet.getRows();
        const item = inventoryRows.find(row => row.get('Nombre').toLowerCase() === productInfo.product.toLowerCase());
        const newStock = parseInt(item.get('Stock Total')) - quantity;
        item.set('Stock Total', newStock);
        await item.save();

        // Crear reserva
        const reservationData = {
            'Fecha': new Date().toISOString(),
            'Cliente': user.get('Nombre') + ' ' + user.get('Apellido'),
            'Telefono': phone,
            'Email': user.get('Mail') || '',
            'CUIT': user.get('CUIT') || 'No especificado',
            'Precio': productInfo.price * quantity,
            'Reference': reference,
            'Producto': productInfo.product,
            'Medidas': productInfo.size,
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

async function cancelReservation(reference, from, threadInfo) {
    try {
        await doc.loadInfo();
        const reservationsSheet = doc.sheetsByTitle['Reservas'];
        const inventorySheet = doc.sheetsByTitle['Inventario'];

        // Buscar la reserva
        const reservationRows = await reservationsSheet.getRows();
        const reservation = reservationRows.find(row =>
            row.get('Reference') === reference &&
            row.get('Telefono').includes(from)
        );

        if (!reservation) {
            return {
                success: false,
                message: "Reserva no encontrada o no pertenece a este usuario"
            };
        }

        // Verificar que la reserva esté en estado 'Pendiente'
        if (reservation.get('Status').toLowerCase() !== 'pendiente') {
            return {
                success: false,
                message: "La reserva no puede ser cancelada porque su estado es: " + reservation.get('Status')
            };
        }

        // Actualizar stock
        const inventoryRows = await inventorySheet.getRows();
        const product = inventoryRows.find(row =>
            row.get('Nombre').toLowerCase() === reservation.get('Producto').toLowerCase() &&
            row.get('Código') === reservation.get('Medidas')
        );

        if (product) {
            const currentStock = parseInt(product.get('Stock Total')) || 0;
            const returnQuantity = parseInt(reservation.get('Cantidad')) || 0;
            product.set('Stock Total', currentStock + returnQuantity);
            await product.save();
        }

        // Actualizar estado de la reserva
        reservation.set('Status', 'Cancelada');
        await reservation.save();

        return {
            success: true,
            message: "Reserva cancelada exitosamente",
            details: {
                reference: reference,
                product: reservation.get('Producto'),
                size: reservation.get('Medidas'),
                quantity: reservation.get('Cantidad'),
                status: 'Cancelada'
            }
        };

    } catch (error) {
        console.error('Error al cancelar la reserva:', error);
        return {
            success: false,
            message: "Error al cancelar la reserva",
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
            store: row.get('Negocio'),
            imageUrl: getImageUrl(row.get('Imagen'))  // Usa la función auxiliar
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

function getImageUrl(imagePath) {
    if (!imagePath) return null;
    if (imagePath.startsWith('http')) {
        return imagePath;
    }
    if (imagePath == null) return null;
    // TODO: Cambiar por la URL de tu servidor en un .env
    return `http://localhost:3000/images/${imagePath}`;
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
                    size: {
                        type: "string",
                        description: "Medida o código del producto"
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
    },
    {
        type: "function",
        function: {
            name: "cancel_reservation",
            description: "Cancela una reserva existente y devuelve el stock",
            parameters: {
                type: "object",
                properties: {
                    reference: {
                        type: "string",
                        description: "Código de referencia de la reserva (formato: RES-YYYYMMDD-XXXX)"
                    }
                },
                required: ["reference"]
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
            // Usar args.size si está disponible
            const product = args.size ?
                `${args.product} ${args.size}` :
                args.product;
            return await makeReservation(from, product, args.quantity, threadInfo);
        case "msearch":
            return await searchProducts(args.query, threadInfo);
        case "cancel_reservation":
            return await cancelReservation(args.reference, from, threadInfo);
        default:
            throw new Error(`Unknown function: ${functionName}`);
    }
}

app.use(express.json());

app.get('/images/:file_id', async (req, res) => {
    try {
        const response = await openai.files.content(req.params.file_id);
        const buffer = Buffer.from(await response.arrayBuffer());

        res.setHeader('Content-Type', 'image/jpeg'); // Ajusta según el tipo de imagen
        res.send(buffer);
    } catch (error) {
        console.error('Error al obtener la imagen:', error);
        res.status(500).send('Error al obtener la imagen');
    }
});

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

        // img
        const content = lastMessage.content.map(item => {
            if (item.type === 'text') {
                // Buscar imágenes en formato Markdown y convertirlas
                const text = item.text.value;
                const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

                const processedContent = [];
                let lastIndex = 0;
                let match;

                while ((match = markdownImageRegex.exec(text)) !== null) {
                    // Agregar el texto antes de la imagen
                    if (match.index > lastIndex) {
                        processedContent.push({
                            type: 'text',
                            content: text.substring(lastIndex, match.index)
                        });
                    }

                    // Agregar la imagen
                    processedContent.push({
                        type: 'image',
                        content: match[2], // URL de la imagen
                        alt: match[1]      // Descripción de la imagen
                    });

                    lastIndex = match.index + match[0].length;
                }

                // Agregar el texto restante después de la última imagen
                if (lastIndex < text.length) {
                    processedContent.push({
                        type: 'text',
                        content: text.substring(lastIndex)
                    });
                }

                return processedContent;
            }
            return [{ type: item.type, content: item.text?.value }];
        }).flat();
        // img end

        res.status(200).json({
            message: content,
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