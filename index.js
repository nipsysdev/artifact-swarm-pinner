import { Octokit } from '@octokit/core';
import * as unzipper from 'unzipper';
import * as fs from 'fs/promises';
import axios from 'axios';
import { Bee } from '@ethersphere/bee-js'
import { Presets, SingleBar } from "cli-progress";
import { Wallet } from "@ethereumjs/wallet";

const OWNER = process.env.OWNER
const REPO = process.env.REPO
const BUILD_NAME = process.env.BUILD_NAME
const V3_WALLET = process.env.V3_WALLET
const V3_PASS = process.env.V3_PASS
const TOPIC = process.env.TOPIC
const OUT_DIR = './artifact'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const bee = new Bee(process.env.BEE_API_URL)

async function getArtifactId() {
  const response = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts', {
    owner: OWNER,
    repo: REPO,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Accept': 'application/vnd.github+json'
    },
    name: BUILD_NAME
  })

  const web3BuildArtifacts = response.data.artifacts
  if (!web3BuildArtifacts?.length) {
    throw new Error(`No artifacts found${BUILD_NAME ? ` with name "${BUILD_NAME}"` : ''}`)
  }

  return web3BuildArtifacts
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]?.id
}

async function downloadAndExtractArtifact(artifactId) {
  const response = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip', {
    owner: OWNER,
    repo: REPO,
    artifact_id: artifactId,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      'Accept': 'application/vnd.github+json'
    }
  })

  const zipUrl = response.url
  const zipStream = await axios({
    url: zipUrl,
    method: 'get',
    responseType: 'stream'
  });

  const unzipperStream = await zipStream.data.pipe(unzipper.Extract({ path: OUT_DIR }))
  await new Promise((resolve, reject) => {
    unzipperStream.on('close', resolve);
    unzipperStream.on('error', reject);
  });
  console.log('Artifact extracted!')
}

async function upload() {
  const batch = (await bee.getAllPostageBatch()).filter(b => b.batchTTL > 0 && b.usable)[0]
  if (!batch) {
    throw new Error('No usable postage batch found')
  }

  const tag = await bee.createTag()
  console.log('Uploading data')
  const { reference } = await bee.uploadFilesFromDirectory(batch.batchID, OUT_DIR, {
    indexDocument: 'index.html',
    errorDocument: '404.html',
    tag: tag && tag.uid,
    pin: true,
    encrypt: false,
    deferred: true,
    redundancyLevel: undefined
  })
  // noinspection HttpUrlsUsage
  console.log(`Uploading done: ${bee.url}/bzz/${reference}/`)
  console.log(`Ref: ${reference}`)

  console.log('Waiting for file chunks to be synced on Swarm network...')

  await waitForFileSynced(tag)

  console.log('Uploading was successful!')
  console.log('Uploading to Feed...')
  await updateFeedAndPrint(batch.batchID, reference)
}

async function updateFeedAndPrint(stamp, chunkReference) {
  const wallet = await Wallet.fromV3(V3_WALLET, V3_PASS)
  const topic = bee.makeFeedTopic(TOPIC)
  const { manifest } = await writeFeed(stamp, wallet, topic, chunkReference)

  console.log(`Feed Manifest URL: ${bee.url}/bzz/${manifest}/`)
  console.log('Successfully uploaded to feed')
}

async function writeFeed(stamp, wallet, topic, chunkReference) {
  const writer = bee.makeFeedWriter('sequence', topic, wallet.getPrivateKey())
  const { reference: manifest } = await bee.createFeedManifest(stamp, 'sequence', topic, wallet.getAddressString())
  const { reference } = await writer.upload(stamp, chunkReference)
  return { reference, manifest }
}

async function waitForFileSynced(tag) {
  const pollingTime = 500
  const pollingTrials = 15
  const progressBar = new SingleBar({ clearOnComplete: true }, Presets.rect)
  let synced = false
  let syncProgress = 0

  progressBar.start(tag.split, 0)
  for (let i = 0; i < pollingTrials; i++) {
    tag = await bee.retrieveTag(tag.uid)
    const newSyncProgress = tag.seen + tag.synced

    if (newSyncProgress > syncProgress) {
      i = 0
    }

    syncProgress = newSyncProgress

    if (syncProgress >= tag.split) {
      synced = true
      break
    }

    progressBar.setTotal(tag.split)
    progressBar.update(syncProgress)
    await sleepMillis(pollingTime)
  }
  progressBar.stop()

  if (synced) {
    console.log('Data has been synced on Swarm network')
  } else {
    console.error('Data syncing timeout')
    process.exit(1)
  }
}

async function sleepMillis(n) {
  return new Promise(e =>
    setTimeout(() => {
      e(!0)
    }, n)
  )
}

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true })

  const artifactId = await getArtifactId()
  console.log(`Last artifact ID: ${artifactId}`)
  await downloadAndExtractArtifact(artifactId);

  if (!(await fs.stat(OUT_DIR)).isDirectory()) {
    console.error(`Directory ${OUT_DIR} does not exist`)
    process.exit(1)
  }

  try {
    await fs.stat(`${OUT_DIR}/index.html`)
  } catch {
    console.error(`No index.html in ${OUT_DIR}`)
    process.exit(1)
  }

  await upload()
  return "done"
}

main().then(r => console.log(r))