const _ = require('lodash');
const { log, getPRNumber } = require('./utils');
const db = require('./db');
const gh = require('./github');
const printDeltaTable = require('./delta-table');
const { sumSizesOf, ZERO_SIZE } = require('./delta');

const REPO = 'Automattic/wp-calypso';
const WATERMARK = 'c52822';
const COMMENT_USER = 'matticbot';

function groupByArea(deltas) {
	return _.groupBy(deltas, (delta) => {
		if (delta.name.startsWith('moment-locale-')) {
			return 'moment-locale';
		}
		if (delta.name.startsWith('async-load-')) {
			return 'async-load';
		}
		if (
			['build', 'domainsLanding', 'entry'].includes(delta.name) ||
			delta.name.startsWith('entry-')
		) {
			return 'entry';
		}
		if (delta.name === 'gridicons') {
			return 'gridicons';
		}
		if (delta.name === 'manifest' || delta.name === 'runtime') {
			return 'runtime';
		}
		if (delta.name === 'style.css') {
			return 'style.css';
		}
		return 'section';
	});
}

function totalDeltasForArea(areaDelta, delta) {
	if (!areaDelta) {
		return {...ZERO_SIZE};
	}

	// Produce an array of arrays:
	// [ [ chunks in use in first commit ] , [ chunks in use in second commit ] ]
	// The items will be unique inside each array.
	const chunksInUse = ['firstChunks', 'secondChunks']
		.map(chunkType => areaDelta.reduce(
			(acc, group) => {
				for (const chunk of group[chunkType]) {
					acc.add(chunk);
				}
				return acc;
			},
			new Set()
		))
		.map(set => [...set]);

	// Produce an array of size objects, representing the sum of all the chunks for each commit:
	// [ { stat_size: 0, parsed_size: 0, gzip_size: 0 }, { stat_size: 0, parsed_size: 0, gzip_size: 0 } ]
	// The first object is for the first commit, and the second object for the second commit.
	const chunkSizes = ['firstSizes', 'secondSizes']
		.map((property, index) => chunksInUse[index].reduce(
			(acc, chunkName) => {
				const chunk = delta.allChunks.find(chunk => chunk.name === chunkName) || {};
				acc = sumSizesOf(acc, chunk[property]);
				return acc;
			},
			{...ZERO_SIZE}
		));

	// Produce a single object with the delta between first and second commit:
	// { stat_size: 0, parsed_size: 0, gzip_size: 0 }
	let deltaSizes = {};
	for (const sizeType in chunkSizes[0]) {
		deltaSizes[sizeType] = chunkSizes[1][sizeType] - chunkSizes[0][sizeType];
	}

	return deltaSizes;
}

const AREAS = [
	{
		id: 'runtime',
		title: 'Webpack Runtime',
		desc:
			'Webpack runtime for loading modules. It is included in the HTML page as an inline script. ' +
			'Is downloaded and parsed every time the app is loaded.',
	},
	{
		id: 'entry',
		title: 'App Entrypoints',
		desc:
			'Common code that is always downloaded and parsed every time the app is loaded, no matter which route is used.',
	},
	{
		id: 'style.css',
		title: 'Legacy SCSS Stylesheet',
		desc: 'The monolithic CSS stylesheet that is downloaded on every app load.',
		desc_inc:
			'👎 This PR increases the size of the stylesheet, which is a bad news. ' +
			'Please consider migrating the CSS styles you modified to webpack imports.',
		desc_dec: '👍 Thanks for making the stylesheet smaller in this PR!',
	},
	{
		id: 'section',
		title: 'Sections',
		desc:
			'Sections contain code specific for a given set of routes. ' +
			'Is downloaded and parsed only when a particular route is navigated to.',
	},
	{
		id: 'async-load',
		title: 'Async-loaded Components',
		desc:
			'React components that are loaded lazily, when a certain part of UI is displayed for the first time.',
	},
	{
		id: 'gridicons',
		title: 'Gridicons',
		desc:
			'Set of SVG icons that is loaded asynchronously to not delay the initial load. ' +
			'Unless you are modifying Gridicons, you should not see any change here.',
	},
	{
		id: 'moment-locale',
		title: 'Moment.js Locales',
		desc:
			'Locale data for moment.js. Unless you are upgrading the moment.js library, changes in these chunks are suspicious.',
	},
];

function watermarkString(watermark) {
	return `icfy-watermark: ${watermark}`;
}

async function getDelta(push) {
	return await db.getPushDelta(push.ancestor, push.sha, { extractManifestGroup: true });
}

function statsMessage(delta) {
	const byArea = groupByArea(delta.groups);

	const message = [];

	message.push(`<!-- ${watermarkString(WATERMARK)} -->`);
	if (_.isEmpty(byArea)) {
		message.push(
			"This PR does not affect the size of JS and CSS bundles shipped to the user's browser."
		);
	} else {
		message.push(
			"Here is how your PR affects size of JS and CSS bundles shipped to the user's browser:"
		);

		for (const area of AREAS) {
			const areaDelta = byArea[area.id];
			if (!areaDelta) {
				continue;
			}

			const bytesDelta = totalDeltasForArea(areaDelta, delta).gzip_size || 0;
			const changedBytes = Math.abs(bytesDelta);
			const suffix = bytesDelta < 0 ? 'removed 📉' : 'added 📈';

			message.push('');
			message.push(`**${area.title}** (~${changedBytes} bytes ${suffix} [gzipped])`);
			message.push('<details>');
			message.push('');

			message.push('```');
			message.push(printDeltaTable(areaDelta));
			message.push('```');

			message.push('');
			message.push(area.desc);
			if (area.desc_inc && _.every(areaDelta, (delta) => delta.deltaSizes.gzip_size > 0)) {
				message.push(area.desc_inc);
			} else if (area.desc_dec && _.every(areaDelta, (delta) => delta.deltaSizes.gzip_size < 0)) {
				message.push(area.desc_dec);
			}

			message.push('</details>');
		}

		message.push('');
		message.push('**Legend**');
		message.push('<details>');
		message.push('<summary>What is parsed and gzip size?</summary>');
		message.push('');
		message.push(
			'**Parsed Size:** Uncompressed size of the JS and CSS files. This much code needs to be parsed and stored in memory.'
		);
		message.push(
			'**Gzip Size:** Compressed size of the JS and CSS files. This much data needs to be downloaded over network.'
		);
		message.push('</details>');
	}
	message.push('');
	message.push(
		'Generated by performance advisor bot at [iscalypsofastyet.com](http://iscalypsofastyet.com).'
	);

	return message.join('\n');
}

async function getOurPRCommentIDs(repo, prNum) {
	const prComments = await gh.getPRComments(repo, prNum);
	return prComments.data
		.filter((comment) => comment.user.login === COMMENT_USER)
		.filter((comment) => comment.body.includes(watermarkString(WATERMARK)))
		.map((comment) => comment.id);
}

module.exports = async function commentOnGithub(sha) {
	const [push] = await db.getPush(sha);

	if (!push) {
		log('Cannot find push to comment on:', sha);
		return;
	}

	if (['master', 'trunk'].includes(push.branch) || !push.ancestor) {
		log('Push not eligible for comment:', sha);
		return;
	}

	const prNumber = getPRNumber(push);
	if (prNumber === null) {
		log('Cannot find a PR number on the push:', push.sha, push.message);
	}

	log('Commenting on PR', prNumber);

	const [firstComment, ...otherComments] = await getOurPRCommentIDs(REPO, prNumber);

	const message = statsMessage(await getDelta(push));

	if (!firstComment) {
		log('Posting first comment on PR', prNumber);
		await gh.createPRComment(REPO, prNumber, message);
	} else {
		log('Updating existing comment on PR', prNumber, firstComment);
		await gh.editPRComment(REPO, firstComment, message);
	}

	for (const otherComment of otherComments) {
		log('Removing outdated comment on PR', prNumber, otherComment);
		await gh.deletePRComment(REPO, otherComment);
	}

	log('Commented on PR', prNumber);
};
