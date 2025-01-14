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

// RAM-Generations
const cpuSockets: MyDictionary = {
	DDR2: "#mt=ddr2",
	DDR3: "#mt=ddr3",
	DDR4: "#mt=ddr4",
	DDR5: "#mt=ddr5",
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
				await page.goto(`${BASE_URL}/${endpoint}/${socketUrl}&page=${currentPage}`, { waitUntil: 'load' })
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
