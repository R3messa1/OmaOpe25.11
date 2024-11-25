import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fetch from 'node-fetch';  // Käytetään API-kutsuihin OpenAI:lle
import multer from 'multer';
import vision from '@google-cloud/vision'; //Google Cloud Vision API:n käyttöön
import fs from 'fs';

dotenv.config(); // Lataa .env-tiedoston ympäristömuuttujat

const app = express();
const port = 3000;

app.use(bodyParser.json());  // Mahdollistaa JSON-datan vastaanoton POST-pyynnöissä
app.use(express.static('public'));  // Palvellaan staattiset tiedostot (HTML, CSS, JS)

// Multer-instanssi tiedostojen tallentamiseen
const upload = multer({ dest: 'uploads/' });

//Luo Google Cloud Vision -asiakas käyttäen omaope-vision.json -tiedostoa
const client = new vision.ImageAnnotatorClient({
    keyFilename: 'omaope-vision.json'
});
//Määritellään viestihistoriaa varten context-muuttuja tyhjäksi taulukoksi
let context = [];

//Muutujat kysymyksen ja oikean vastauksen tallentamiseen
let currentQuestion = '';
let correctAnswer = '';

// POST-pyyntö reitille /chat, joka vastaanottaa käyttäjän viestin ja vastaa siihen
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;  // Haetaan käyttäjän viesti front-endiltä

    console.log('Käyttäjän viesti:', userMessage);  // Tulostetaan käyttäjän viesti konsoliin (debug)

    // Tarkistetaan, että viesti ei ole tyhjä
    if (!userMessage) {
        return res.status(400).json({ error: 'Viestikenttä on tyhjä.' });  // Palautetaan virhe, jos viesti puuttuu
    }

    try {
        // Lähetetään viesti OpenAI GPT-4 API:lle
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',  // Pyynnön sisältö on JSON-muodossa
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`  // Käytetään .env-tiedostossa olevaa API-avainta
            },
            body: JSON.stringify({
                model: 'gpt-4',  // Käytetään GPT-4-mallia
                messages: [
                    { role: 'user', content: userMessage }  // Käyttäjän viesti lähetetään API:lle
                ],
                max_tokens: 150  // Määritetään maksimitokenien määrä vastaukselle (rajoittaa vastauksen pituutta)
            })
        });

        const data = await response.json();  // Muutetaan API:n vastaus JSON-muotoon
        console.log('API vastaus (kokonaisuus):', data);  // Tulostetaan koko API-vastaus konsoliin

        // Tarkistetaan, että saatiin vastaus OpenAI API:lta
        if (!data.choices || data.choices.length === 0) {
            return res.status(500).json({ error: 'API ei palauttanut vastauksia.' });
        }

        // Haetaan vastaus oikeasta kohdasta ja puretaan message-objekti
        const reply = data.choices[0].message.content.trim();  // Haetaan ja trimataan vastaus
        console.log('API vastaus (sisältö):', reply);  // Tulostetaan vastauksen sisältö konsoliin

        res.json({ reply });  // Palautetaan vastaus front-endille JSON-muodossa

    } catch (error) {
        // Käsitellään virhetilanteet, jos API-kutsu epäonnistuu
        console.error('Virhe API-kutsussa:', error.message);  // Tulostetaan virheviesti konsoliin
        res.status(500).json({ error: 'Internal Server Error' });  // Palautetaan virheviesti front-endille
    }
});

// Kuvien vastaanotto ja OCR-prosessi reitillä upload
app.post('/upload', upload.array('images', 10), async (req, res) => {
    console.log('Received images upload');
    const files = req.files;

    // Tiedostojen validointi
    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }

    let combinedText = '';

    try {
        // Suoritetaan OCR-tunnistus kaikille kuville
        const texts = await Promise.all(files.map(async file => {
            const imagePath = file.path;
            const [result] = await client.textDetection(imagePath);
            const detections = result.textAnnotations;
            fs.unlinkSync(imagePath);
            return detections.length > 0 ? detections[0].description : '';
        }));

        //Yhdistetään kaikkien kuvien tekstit yhdeksi merkkijonoksi
        combinedText = texts.join(' ');
        console.log('OCR Combined text:', combinedText);

        context = [{ role: 'user', content: combinedText}];

        //Lähetetään API-pyyntö GPT-4 mallille kysymyksen luomiseksi OCR-tekstistä
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: context.concat([
                    {
                       role: 'user',
                       content: 'Luo yksi yksinkertainen ja selkeä koetehtävä ja sen vastaus yllä olevasta tekstistä suomeksi. Kysy vain yksi asia kerrallaan' 
                    }
                ]),
                max_tokens: 150
            })
        });
        //Muutetaan API:n vastaus JSON-muotoon ja tulostetaan se konsoliin
        const data = await response.json();
        console.log(data.choices[0].message);
        console.log('API response:', JSON.stringify(data, null, 2));

        //Tarkistetaan, että API palautti kelvollisen vastauksen
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
            throw new Error('No valid choices returned from API');
        }

        //Haetaan ja käsitellään API-vastaus ja tallennetaan se responseText-muuttujaan
        const responseText = data.choices[0].message.content.trim();
        console.log('Response Text:', responseText);

        //Pilkotaan vastaus kysymykseen ja vastaukseen
        const [question, answer] = responseText.includes('Vastaus:')
            ? responseText.split('Vastaus:')
            : [responseText, null];

            console.log('Parsed Question:', question);
            console.log('Parsed Answer:', answer);

            //Tarkistetaan, että kysymys ja vastaus ovat olemassa, muuten palautetaan virhe
            if (!question || !answer) {
                return res.status(400).json({ error: 'Model could not generate a valid question. Please provide a clearer text.' });
            }

            //Siivotaan kysymys ja vastaus ja tallennetaan ne
            currentQuestion = question.trim();
            correctAnswer = answer.trim();
            
            //Päivitetään keskusteluhistoria lisäämällä kysymys ja vastaus
            context.push({ role: 'assistant', content: `Kysymys: ${currentQuestion}`});
            context.push({ role: 'assistant', content: `Vastaus: ${correctAnswer}`});

            console.log('Parsed Question:', currentQuestion);
            console.log('Parsed Answer:', correctAnswer);

            //Palautetaan JSON-vastaus, jossa on kysymys ja vastaus
            res.json({ question: currentQuestion, answer: correctAnswer});
            

    } catch (error) { 
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Käynnistetään palvelin ja asetetaan se kuuntelemaan porttia 3000
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
