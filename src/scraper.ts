import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Page } from 'puppeteer'
import { Cluster } from 'puppeteer-cluster'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import untypedMap from './serialization-map.json'
import {
	customSerializers,
	genericSerialize,
	serializeNumber,
} from './serializers'
import type { Part, PartType, SerializationMap } from './types'

const BASE_URL = 'https://pcpartpicker.com/products'
const STAGING_DIRECTORY = 'data-staging'
const ALL_ENDPOINTS: PartType[] = [
	'cpu',
	'cpu-cooler',
	'motherboard',
	'memory',
	'internal-hard-drive',
	'video-card',
	'case',
	'power-supply',
	'os',
	'monitor',
	'sound-card',
	'wired-network-card',
	'wireless-network-card',
	'headphones',
	'keyboard',
	'mouse',
	'speakers',
	'webcam',
	'case-accessory',
	'case-fan',
	'fan-controller',
	'thermal-paste',
	'external-hard-drive',
	'optical-drive',
	'ups',
]

type MyDictionary = Record<string, string>;

// cpu-Socket cpu/#k=<number>
const cpuSockets: MyDictionary = {
	AM1:"#k=27",
	AM2p: "#k=2",
	AM3: "#k=3",
	AM3p: "#k=4",
	AM4: "#k=33", 
	AM5: "#k=41",
	FM1: "#k=20",
	FM2: "#k=23",
	FM2p: "#k=26",
	G34: "#k=31",
	LGA771: "#k=12",
	LGA775: "#k=13",
	LGA1150: "#k=24",
	LGA1151: "#k=30",
	LGA1155: "#k=14",
	LGA1156: "#k=15",
	LGA1200: "#k=39",
	LGA1356: "#k=37",
	LGA1366: "#k=16",
	LGA1700: "#k=40",
	LGA2011: "#k=21",
	LGA2011_3: "#k=28",
	LGA2066: "#k=35",
	sTR4: "#k=36",
	sTRX4: "#k=38"
}


puppeteer.use(StealthPlugin())

const map = untypedMap as unknown as SerializationMap

async function scrapeInParallel(endpoints: PartType[]) {
	await mkdir(join(STAGING_DIRECTORY, 'json'), { recursive: true })

	const cluster = await Cluster.launch({
		concurrency: Cluster.CONCURRENCY_PAGE,
		maxConcurrency: 5,
		timeout: 1000 * 60 * 20, // 20 minutes
		puppeteer,
		puppeteerOptions: {
			headless: false,
		},
	})

	await cluster.task(async ({ page, data: endpoint }) => {
		await page.setViewport({ width: 1920, height: 1080 })

		const allParts = []

		try {
			for await (const pageParts of scrape(endpoint, page)) {
				allParts.push(...pageParts)
			}
		} catch (error) {
			console.warn(`[${endpoint}] Aborted unexpectedly:\n\t${error}`)
		}

		await writeFile(
			join(STAGING_DIRECTORY, 'json', `${endpoint}.json`),
			JSON.stringify(allParts)
		)
	})

	cluster.queue('https://pcpartpicker.com', async ({ page, data }) => {
		await page.goto(data)
		await page.waitForSelector('nav')

		for (const endpoint of endpoints) {
			cluster.queue(endpoint)
		}
	})

	await cluster.idle()
	await cluster.close()
}

async function* scrape(endpoint: PartType, page: Page): AsyncGenerator<Part[]> {
	
	for (const [_, socketUrl] of Object.entries(cpuSockets)) {
		const fullUrl = `${BASE_URL}/${endpoint}/${socketUrl}`;
		await page.goto(fullUrl, { waitUntil: 'domcontentloaded' })
		await page.waitForNetworkIdle()
		
		const paginationEl = await page.waitForSelector('.pagination', {
		timeout: 5000,
		})
		
		// NOTE: We are banging paginationEl because Page.waitForSelector()
		// only returns null when using option `hidden: true`, which we
		// are not using.
		// See: https://pptr.dev/api/puppeteer.page.waitforselector#parameters
		const numPages = await paginationEl!.$eval('li:last-child', (el) =>
			parseInt(el.innerText)
		)
		
		for (let currentPage = 1; currentPage <= numPages; currentPage++) {
			const pageProducts: Part[] = []
	
			if (currentPage > 1) {
				await page.goto(`${BASE_URL}/${endpoint}/#page=${currentPage}`)
				await page.waitForNetworkIdle()
			}
	
			const productEls = await page.$$('.tr__product')
	
			for (const productEl of productEls) {
				const serialized: Part = {}
				// Exctracting socket name from Current CPU socket
				const socketName = Object.keys(cpuSockets).find(
					(key) => cpuSockets[key] === socketUrl
				)

	
				serialized['name'] = `${socketName} ${await productEl.$eval(
					'.td__name .td__nameWrapper > p',
					(p) => p.innerText
				)}`
	
				const priceText = await productEl.$eval(
					'.td__price',
					(td) => td.textContent
				)
	
				if (priceText == null || priceText.trim() === '')
					serialized['price'] = null
				else serialized['price'] = serializeNumber(priceText)
	
				const specs = await productEl.$$('td.td__spec')
	
				for (const spec of specs) {
					const specName = await spec.$eval('.specLabel', (l) =>
						(l as HTMLHeadingElement).innerText.trim()
					)
					const mapped = map[endpoint][specName]
	
					if (typeof mapped === 'undefined')
						throw new Error(`No mapping found for spec '${specName}'`)
	
					const [snakeSpecName, mappedSpecSerializationType] = mapped
	
					const specValue = await spec.evaluate((s) => s.innerText)
	
					if (specValue.trim() === '') {
						serialized[snakeSpecName] = null
					} else if (mappedSpecSerializationType === 'custom') {
						serialized[snakeSpecName] =
							customSerializers[endpoint]![snakeSpecName]!(specValue)
					} else {
						serialized[snakeSpecName] = genericSerialize(
							specValue,
							mappedSpecSerializationType
						)
					}
				}
	
				pageProducts.push(serialized)
			}
	
			yield pageProducts
		}
	}
	
}

const inputEndpoints = process.argv.slice(2)
const endpointsToScrape = inputEndpoints.length
	? (inputEndpoints as PartType[])
	: ALL_ENDPOINTS

scrapeInParallel(endpointsToScrape)
