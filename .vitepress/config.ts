import { defineConfig } from 'vitepress'
import { genFeed } from './genFeed.js'
const defaultMetaDescription = "PDF table convertor"

export default defineConfig({
  base: '/blog/',
  head: [
    ['meta', { name: 'twitter:site', content: '@vuejs' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    [
      'meta',
      {
        name: 'twitter:image',
        content: 'https://vuejs.org/images/logo.png'
      }
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/x-icon',
        href: '/favicon.ico'
      }
    ],
    [
      'script',
      {
        src: 'https://cdn.usefathom.com/script.js',
        'data-site': 'NYHGSGQV',
        'data-spa': 'auto',
        defer: ''
      }
    ]
  ],
  transformPageData(pageData) {
    const canonicalUrl = `https://dashboard.flowfuse.com/${pageData.relativePath}`
      .replace(/index\.md$/, '')
      .replace(/\.md$/, '.html')

    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push([
      'link',
      { rel: 'canonical', href: canonicalUrl }
    ])

    const metaDescription =
      pageData.frontmatter.description === undefined
        ? defaultMetaDescription
        : pageData.frontmatter.description

    pageData.frontmatter.head.push([
      'meta',
      { name: 'description', content: metaDescription }
    ])
  },

  title: 'PDF Table Convert',
  description: 'The official blog for pdfextractor project',
  cleanUrls: true,
  buildEnd: genFeed
})
