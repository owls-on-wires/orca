const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack = require('webpack');
const fs = require('fs');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  // Dynamically generate HtmlWebpackPlugin instances for all HTML files
  const htmlDir = path.resolve(__dirname, 'src/html');
  const htmlFiles = fs.readdirSync(htmlDir).filter(file => file.endsWith('.html'));
  
  const htmlPlugins = htmlFiles.map(filename => {
    const isIndex = filename === 'index.html';
    return new HtmlWebpackPlugin({
      template: path.join(htmlDir, filename),
      filename: filename,
      inject: isIndex ? true : 'body', // index.html gets full injection, others get body injection
    });
  });

  return {
    entry: './src/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProduction ? '[name].[contenthash].js' : '[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : 'style-loader',
            'css-loader',
            'postcss-loader',
          ],
        },
        {
          test: /\.(otf|woff|woff2|ttf|eot)$/,
          type: 'asset/resource',
          generator: { filename: 'fonts/[name][ext]' },
        },
        {
          test: /\.svg$/,
          type: 'asset/resource',
          generator: { filename: 'assets/[name][ext]' },
        },
      ],
    },
    plugins: [
      ...htmlPlugins,
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
      }),
      ...(isProduction ? [new MiniCssExtractPlugin({
        filename: '[name].[contenthash].css',
      })] : []),
    ],
    devServer: {
      static: './dist',
      port: 8095,
      hot: true,
      open: false,
    },
  };
};
